import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import type { Client } from "discord.js";
import type { Logger } from "pino";

import type { AccessPolicyService } from "../application/access/access-policy-service.js";
import { StaticAdventureLibrary } from "../application/campaign/adventures/static-adventure-library.js";
import { CampaignCommandBus } from "../application/campaign/campaign-command-bus.js";
import { CampaignLobbyService } from "../application/campaign/campaign-lobby-service.js";
import { CampaignPlayController } from "../application/campaign/campaign-play-controller.js";
import { CampaignRuntime } from "../application/campaign/campaign-runtime.js";
import { LlmCampaignNarrator, LlmCampaignPlanner } from "../application/campaign/dm/llm-dm.js";
import type { CampaignNarrator, CampaignPlanner } from "../application/campaign/ports/dm-ports.js";
import type { CampaignTransaction, CampaignUnitOfWork } from "../application/campaign/ports/campaign-store.js";
import type { StructuredModelClient } from "../application/campaign/ports/structured-model-client.js";
import { CryptoRandomSource } from "../application/campaign/random/crypto-random-source.js";
import { RulesetCatalog } from "../application/campaign/rules/ruleset-catalog.js";
import { SystemClock } from "../application/campaign/time/system-clock.js";
import { DeliveryWorker } from "../application/campaign/workers/delivery-worker.js";
import { DmJobWorker } from "../application/campaign/workers/dm-job-worker.js";
import { RollWorker } from "../application/campaign/workers/roll-worker.js";
import { TimerWorker } from "../application/campaign/workers/timer-worker.js";
import type { ApplicationConfiguration } from "../config/configuration.js";
import { enSrd51Glossary } from "../application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { buildSrd51 } from "../domain/campaign/content/srd-5.1/index.js";
import { milestone0Capabilities } from "../domain/campaign/rules/capabilities.js";
import { GeminiStructuredClient } from "../infrastructure/campaign/llm/gemini-structured-client.js";
import { OpenAiCompatibleStructuredClient } from "../infrastructure/campaign/llm/openai-compatible-structured-client.js";
import { OpenAiResponsesStructuredClient } from "../infrastructure/campaign/llm/openai-responses-structured-client.js";
import { loadStarterAdventure, starterAdventureId } from "../infrastructure/campaign/starter-adventures.js";
import { CampaignAuthority } from "../infrastructure/discord/campaign/campaign-authority.js";
import { CampaignCardService } from "../infrastructure/discord/campaign/campaign-card-service.js";
import { CampaignGameCreator } from "../infrastructure/discord/campaign/campaign-game-creator.js";
import { DiscordMessageGateway } from "../infrastructure/discord/campaign/campaign-message-gateway.js";
import { DiscordCampaignPresenter } from "../infrastructure/discord/campaign/campaign-presenter.js";
import { DiscordResourceGateway } from "../infrastructure/discord/campaign/campaign-resource-gateway.js";
import { CampaignSetupService } from "../infrastructure/discord/campaign/campaign-setup-service.js";
import { DndCommand } from "../infrastructure/discord/commands/campaign/dnd-command.js";
import { CampaignComponentHandler } from "../infrastructure/discord/components/campaign-component-handler.js";
import { CampaignHubComponentHandler } from "../infrastructure/discord/components/campaign-hub-component-handler.js";
import { SqliteCampaignStore } from "../infrastructure/persistence/campaign/sqlite-campaign-store.js";

export interface CampaignModule {
  readonly command: DndCommand;
  readonly handler: CampaignComponentHandler;
  // The hub's Create game wizard and Manage views.
  readonly hubHandler: CampaignHubComponentHandler;
  // Discord events that can take a card or a place away: a message was
  // deleted (or many at once), or a channel was. Each puts things back.
  handleMessagesDeleted(guildId: string, channelId: string, messageIds: readonly string[]): void;
  handleChannelDeleted(guildId: string, channelId: string): void;
  // Recovers after a restart and starts the background workers. Call once
  // the Discord client is ready.
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CampaignModuleInput {
  readonly configuration: ApplicationConfiguration;
  readonly logger: Logger;
  readonly client: Client;
  readonly accessPolicyService: AccessPolicyService;
}

// The whole campaign stack (plan §11): store, engine bus, workers, the AI
// DM, Discord cards, setup, and the /dnd command with its controls. It is cheap
// to build and touches nothing until start(): the database opens on first use
// and no model is called, so command deployment can build it too.
export function createCampaignModule(input: CampaignModuleInput): CampaignModule {
  const { configuration, client } = input;
  const logger = input.logger.child({ component: "campaign" });

  let database: Database.Database | null = null;
  let store: SqliteCampaignStore | null = null;
  const openStore = (): SqliteCampaignStore => {
    if (store === null) {
      const file = resolve(configuration.runtimeDataDirectory, "campaign.sqlite");
      mkdirSync(dirname(file), { recursive: true });
      database = new Database(file);
      store = new SqliteCampaignStore(database);
    }
    return store;
  };
  const unitOfWork: CampaignUnitOfWork = { transaction: <T>(work: (tx: CampaignTransaction) => Promise<T>): Promise<T> => openStore().transaction(work) };

  const content = buildSrd51({ capabilities: milestone0Capabilities, glossaries: [enSrd51Glossary, zhTwSrd51Glossary] });
  const rulesets = new RulesetCatalog([content]);
  const glossaries = { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary };
  const adventures = new StaticAdventureLibrary([{ id: starterAdventureId, editions: loadStarterAdventure() }]);
  const clock = new SystemClock();

  let runtime: CampaignRuntime | null = null;
  const bus = new CampaignCommandBus({ unitOfWork, rulesets, clock, onWorkQueued: (): void => runtime?.kick() });

  const messages = new DiscordMessageGateway(client);
  const cards = new CampaignCardService({ unitOfWork, rulesets, adventures, messages, glossaries, logger });
  const presenter = new DiscordCampaignPresenter({ unitOfWork, messages, cards, adventures, glossaries });
  const lobby = new CampaignLobbyService({
    unitOfWork,
    bus,
    adventures,
    clock,
    ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
  });
  const play = new CampaignPlayController({ unitOfWork, bus, refresher: cards, adventures });
  const setup = new CampaignSetupService({ unitOfWork, resources: new DiscordResourceGateway(client), cards, logger });

  const model = createModelClient(configuration);
  const cacheKey = "dnd";
  const planner: CampaignPlanner = model === null ? unavailablePlanner : new LlmCampaignPlanner({ client: model, cacheKey });
  const narrator: CampaignNarrator = model === null ? unavailableNarrator : new LlmCampaignNarrator({ client: model, cacheKey });

  runtime = new CampaignRuntime({
    unitOfWork,
    bus,
    rolls: new RollWorker(unitOfWork, bus, new CryptoRandomSource(), clock),
    timers: new TimerWorker(unitOfWork, bus, clock),
    dm: new DmJobWorker({ unitOfWork, bus, planner, narrator, adventures, glossaries }),
    delivery: new DeliveryWorker(unitOfWork, presenter),
    logger,
    bootId: randomUUID(),
  });
  const running = runtime;

  const authority = new CampaignAuthority(input.accessPolicyService, unitOfWork);
  const creator = new CampaignGameCreator({ lobby, setup, defaultAdventureId: starterAdventureId, modelConfigured: model !== null });
  const command = new DndCommand({ lobby, play, setup, cards, creator, authority });
  const handler = new CampaignComponentHandler({ lobby, play, cards, unitOfWork, rulesets, adventures, glossaries });
  const hubHandler = new CampaignHubComponentHandler({ lobby, play, setup, cards, creator, authority });

  // A deleted hub channel or game channel is made again (its cards are drawn
  // into the new one); a deleted message is drawn again by the card service.
  const recoverChannel = async (guildId: string, channelId: string): Promise<void> => {
    const settings = await unitOfWork.transaction((tx) => tx.loadGuildSettings(guildId));
    if (settings?.hubChannelId === channelId) {
      await setup.setupGuild(guildId, null);
      return;
    }
    const found = await lobby.findByChannel(guildId, [channelId]);
    if (found === undefined || found.record.lifecycle === "archived") return;
    await setup.provision(found.record.key);
    await cards.sync(found.record.key, true);
  };
  const logFailure = (what: string, guildId: string): ((error: unknown) => void) => (error): void => {
    logger.error({ err: error, guildId }, what);
  };

  return {
    command,
    handler,
    hubHandler,
    handleMessagesDeleted: (guildId, channelId, messageIds): void => {
      void cards.handleMessagesDeleted(guildId, channelId, messageIds).catch(logFailure("Campaign card recovery after a deleted message failed", guildId));
    },
    handleChannelDeleted: (guildId, channelId): void => {
      void recoverChannel(guildId, channelId).catch(logFailure("Campaign channel recovery failed", guildId));
    },
    start: async (): Promise<void> => {
      openStore();
      const report = await running.start();
      logger.info({ modelConfigured: model !== null, paused: report.paused.length, firstRoundsOpened: report.firstRoundsOpened.length }, "Campaign runtime started");
      // Cards deleted while the bot was away come back; this needs Discord, so it does not hold up startup.
      void cards.recoverAll().catch((error: unknown) => logger.error({ err: error }, "Campaign card recovery at startup failed"));
    },
    stop: async (): Promise<void> => {
      await running.stop();
      if (database?.open === true) database.close();
    },
  };
}

function createModelClient(configuration: ApplicationConfiguration): StructuredModelClient | null {
  const model = configuration.campaign;
  if (model === null) return null;
  switch (model.provider) {
    case "openai-responses":
      return new OpenAiResponsesStructuredClient({ baseUrl: model.baseUrl, apiKey: model.apiKey, models: model.models, reasoningEffort: model.reasoningEffort });
    case "openai-compatible":
      return new OpenAiCompatibleStructuredClient({ baseUrl: model.baseUrl, apiKey: model.apiKey, models: model.models });
    case "gemini":
      return new GeminiStructuredClient({ apiKey: model.apiKey, models: model.models, ...(model.thinkingBudget === null ? {} : { thinkingBudget: model.thinkingBudget }) });
  }
}

// With no model configured, /dnd new refuses; if a campaign somehow exists,
// its DM jobs fail visibly and retry rather than inventing an outcome.
const unavailablePlanner: CampaignPlanner = { plan: () => Promise.reject(new Error("CAMPAIGN_MODEL is not configured.")) };
const unavailableNarrator: CampaignNarrator = {
  narrate: () => Promise.reject(new Error("CAMPAIGN_MODEL is not configured.")),
  narrateCombat: () => Promise.reject(new Error("CAMPAIGN_MODEL is not configured.")),
};
