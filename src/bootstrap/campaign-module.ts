import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import type { Client } from "discord.js";
import type { Logger } from "pino";

import type { AccessPolicyService } from "../application/access/access-policy-service.js";
import { AdventureAuthor } from "../application/campaign/adventures/adventure-author.js";
import { AdventureCatalog } from "../application/campaign/adventures/adventure-catalog.js";
import { StaticAdventureLibrary } from "../application/campaign/adventures/static-adventure-library.js";
import { UploadedAdventureLibrary } from "../application/campaign/adventures/uploaded-adventure-library.js";
import { CampaignCommandBus } from "../application/campaign/campaign-command-bus.js";
import { CampaignIssues } from "../application/campaign/campaign-issues.js";
import { CharacterLibrary } from "../application/campaign/library/character-library.js";
import { CampaignLobbyService } from "../application/campaign/campaign-lobby-service.js";
import { CampaignPlayController } from "../application/campaign/campaign-play-controller.js";
import { CampaignRuntime } from "../application/campaign/campaign-runtime.js";
import { LlmCampaignChronicler } from "../application/campaign/dm/llm-chronicler.js";
import { LlmCampaignNarrator, LlmCampaignPlanner } from "../application/campaign/dm/llm-dm.js";
import type { CampaignNarrator, CampaignPlanner } from "../application/campaign/ports/dm-ports.js";
import type { CampaignTransaction, CampaignUnitOfWork } from "../application/campaign/ports/campaign-store.js";
import type { StructuredModelClient } from "../application/campaign/ports/structured-model-client.js";
import { CryptoRandomSource } from "../application/campaign/random/crypto-random-source.js";
import { RulesetCatalog } from "../application/campaign/rules/ruleset-catalog.js";
import { SystemClock } from "../application/campaign/time/system-clock.js";
import { DeliveryWorker } from "../application/campaign/workers/delivery-worker.js";
import { ImageWorker } from "../application/campaign/workers/image-worker.js";
import { monsterGalleryImage } from "../infrastructure/campaign/image/monster-gallery.js";
import { FileImageAssetStore } from "../infrastructure/campaign/image/file-image-asset-store.js";
import { OpenAiImageGenerator } from "../infrastructure/campaign/image/openai-image-generator.js";
import { OpenAiImageStylizer } from "../infrastructure/campaign/image/openai-image-stylizer.js";
import { FilePortraitStore } from "../infrastructure/campaign/image/file-portrait-store.js";
import { CharacterPortraits } from "../application/campaign/library/character-portraits.js";
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
import { CampaignSettingsAccess } from "../infrastructure/discord/campaign/campaign-settings-access.js";
import { CampaignGameCreator } from "../infrastructure/discord/campaign/campaign-game-creator.js";
import { DiscordMessageGateway } from "../infrastructure/discord/campaign/campaign-message-gateway.js";
import { DiscordCampaignPresenter } from "../infrastructure/discord/campaign/campaign-presenter.js";
import { DiscordResourceGateway } from "../infrastructure/discord/campaign/campaign-resource-gateway.js";
import { CampaignRecovery } from "../infrastructure/discord/campaign/campaign-recovery.js";
import { CampaignSetupService } from "../infrastructure/discord/campaign/campaign-setup-service.js";
import { organizerNotice } from "../infrastructure/discord/campaign/issue-notifier.js";
import { DndCommand } from "../infrastructure/discord/commands/campaign/dnd-command.js";
import { CampaignComponentHandler } from "../infrastructure/discord/components/campaign-component-handler.js";
import { AdventureIntake } from "../infrastructure/discord/campaign/adventure-intake.js";
import { AdventureComponentHandler } from "../infrastructure/discord/components/adventure-component-handler.js";
import { CampaignHubComponentHandler } from "../infrastructure/discord/components/campaign-hub-component-handler.js";
import { CharacterLibraryComponentHandler } from "../infrastructure/discord/components/character-library-component-handler.js";
import { createDatabaseConnection, resolveInstanceSchemaName, type DatabaseConnection } from "../infrastructure/database/database.js";
import { PostgresCampaignStore } from "../infrastructure/persistence/campaign/postgres-campaign-store.js";
import { SqliteCampaignStore } from "../infrastructure/persistence/campaign/sqlite-campaign-store.js";

export interface CampaignModule {
  readonly command: DndCommand;
  readonly handler: CampaignComponentHandler;
  // The hub's Create game wizard and Manage views.
  readonly hubHandler: CampaignHubComponentHandler;
  // My Characters: the character library's private screens and builder.
  readonly libraryHandler: CharacterLibraryComponentHandler;
  // Approve or Discard on an uploaded or authored adventure's review.
  readonly adventureHandler: AdventureComponentHandler;
  // What the admin panel's D&D settings read and change.
  readonly settings: CampaignSettingsAccess;
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

  // The campaign data lives where the rest of the bot keeps its own: PostgreSQL
  // when that is the configured persistence (the tables come from the Drizzle
  // migrations), otherwise a SQLite file in the runtime data directory. Either
  // is opened on first use, so building the module touches nothing.
  let database: Database.Database | null = null;
  let postgres: DatabaseConnection | null = null;
  let store: CampaignUnitOfWork | null = null;
  let postgresStore: PostgresCampaignStore | null = null;
  const openStore = (): CampaignUnitOfWork => {
    if (store !== null) return store;
    if (configuration.persistence.driver === "postgres") {
      const { databaseUrl } = configuration.persistence;
      if (!databaseUrl || !configuration.instanceName) throw new Error("PostgreSQL persistence requires DATABASE_URL and INSTANCE_NAME.");
      const schemaName = resolveInstanceSchemaName(configuration.instanceName);
      postgresStore = new PostgresCampaignStore(async () => {
        postgres = await createDatabaseConnection(databaseUrl, schemaName);
        return postgres.database;
      });
      store = postgresStore;
    } else {
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
  const starter = loadStarterAdventure();
  // The bundled adventure plus every adventure a server approved.
  const adventures = new UploadedAdventureLibrary(new StaticAdventureLibrary([{ id: starterAdventureId, editions: starter }]));
  const clock = new SystemClock();

  let runtime: CampaignRuntime | null = null;
  const bus = new CampaignCommandBus({ unitOfWork, rulesets, clock, onWorkQueued: (): void => runtime?.kick() });

  const messages = new DiscordMessageGateway(client);
  const issues = new CampaignIssues({ unitOfWork, clock, notify: organizerNotice(messages) });
  const resources = new DiscordResourceGateway(client);
  const cards = new CampaignCardService({ unitOfWork, rulesets, adventures, messages, glossaries, logger, issues, resources });
  const presenter = new DiscordCampaignPresenter({ unitOfWork, messages, cards, adventures, glossaries, revealDelayMs: 1_200 });
  const library = new CharacterLibrary({ unitOfWork, clock, content, rulesetVersion: content.version });
  // A saved character's portrait: an upload turned into D&D art, or one painted from its description.
  // Both need the image model; without it the portrait screens are simply not offered.
  const portraitStore = new FilePortraitStore(resolve(configuration.runtimeDataDirectory, "character-portraits"));
  const portraits = new CharacterPortraits({
    library,
    store: portraitStore,
    clock,
    ...(configuration.campaignImages === null || configuration.campaignImages === undefined
      ? {}
      : { stylizer: new OpenAiImageStylizer(configuration.campaignImages), generator: new OpenAiImageGenerator(configuration.campaignImages) }),
  });
  const lobby = new CampaignLobbyService({
    unitOfWork,
    library,
    rulesets,
    bus,
    adventures,
    clock,
    ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
    // A players-only game hides its channels once it starts.
    onStarted: (key): void => {
      void setup.applyVisibility(key).catch(logFailure("Campaign visibility could not be applied", key.guildId));
    },
  });
  const play = new CampaignPlayController({ unitOfWork, bus, refresher: cards, adventures });
  const setup = new CampaignSetupService({ unitOfWork, resources, cards, logger, issues });

  const model = createModelClient(configuration);
  const cacheKey = "dnd";
  const planner: CampaignPlanner = model === null ? unavailablePlanner : new LlmCampaignPlanner({ client: model, cacheKey });
  const narrator: CampaignNarrator = model === null ? unavailableNarrator : new LlmCampaignNarrator({ client: model, cacheKey });

  runtime = new CampaignRuntime({
    unitOfWork,
    bus,
    rolls: new RollWorker(unitOfWork, bus, new CryptoRandomSource(), clock),
    timers: new TimerWorker(unitOfWork, bus, clock),
    dm: new DmJobWorker({ unitOfWork, bus, planner, narrator, ...(model === null ? {} : { chronicler: new LlmCampaignChronicler({ client: model, cacheKey }) }), adventures, glossaries }),
    delivery: new DeliveryWorker(unitOfWork, presenter, {
      clock,
      onAbandoned: async (key, item): Promise<void> => {
        await issues.raise(key, "deliveryFailed", item.request.kind === "deliver" ? item.request.delivery.kind : item.request.kind);
      },
    }),
    ...(configuration.campaignImages === null || configuration.campaignImages === undefined
      ? {}
      : {
          images: new ImageWorker({
            unitOfWork,
            adventures,
            generator: new OpenAiImageGenerator(configuration.campaignImages),
            sink: { post: (channelId, image, caption): Promise<void> => messages.sendImage(channelId, image.bytes, image.mediaType, caption) },
            fallback: monsterGalleryImage,
            monsterName: (monsterId, language): string | undefined => glossaries[language].names[monsterId],
            assets: new FileImageAssetStore(resolve(configuration.runtimeDataDirectory, "campaign-images")),
            portraits,
            budgetPerCampaign: configuration.campaignImages.budget,
          }),
        }),
    logger,
    bootId: randomUUID(),
  });
  const running = runtime;

  const authority = new CampaignAuthority(input.accessPolicyService, unitOfWork);
  const creator = new CampaignGameCreator({ lobby, setup, defaultAdventureId: starterAdventureId, modelConfigured: model !== null, adventures });
  const libraryHandler = new CharacterLibraryComponentHandler({ library, content, glossaries, portraits });
  const catalog = new AdventureCatalog({ unitOfWork, clock, content, library: adventures });
  // The Author never writes heroes: it borrows the bundled adventure's, in the language asked for.
  const author = model === null ? null : new AdventureAuthor({ client: model, content, heroesFor: (language): typeof starter.en.heroes => starter[language].heroes });
  const intake = new AdventureIntake({ catalog, author, glossaries });
  const adventureHandler = new AdventureComponentHandler({ catalog, authority });
  const command = new DndCommand({ lobby, play, setup, cards, creator, authority, library, libraryScreens: libraryHandler, intake });
  const handler = new CampaignComponentHandler({ lobby, play, cards, unitOfWork, rulesets, adventures, glossaries, library });
  const hubHandler = new CampaignHubComponentHandler({ lobby, play, setup, cards, creator, authority, adventures });

  // A deleted hub channel or game post (a forum thread) is made again (its
  // cards are drawn into the new one), within limits; a deleted message is
  // drawn again by the card service.
  const recovery = new CampaignRecovery({ unitOfWork, lobby, setup, cards, issues, logger });
  let cardRecovery: Promise<void> | null = null;
  let cardReconciliation: Promise<void> | null = null;
  let reconcileTimer: NodeJS.Timeout | null = null;
  const reconcileCards = (): void => {
    if (cardRecovery !== null || cardReconciliation !== null) return;
    cardReconciliation = cards.reconcileAll()
      .catch((error: unknown) => logger.error({ err: error }, "Campaign card reconciliation failed"))
      .finally(() => { cardReconciliation = null; });
  };
  const recoverChannel = (guildId: string, channelId: string): Promise<void> => recovery.channelDeleted(guildId, channelId);
  const logFailure = (what: string, guildId: string): ((error: unknown) => void) => (error): void => {
    logger.error({ err: error, guildId }, what);
  };

  return {
    command,
    handler,
    hubHandler,
    libraryHandler,
    adventureHandler,
    settings: new CampaignSettingsAccess({ unitOfWork, lobby, setup, modelConfigured: model !== null }),
    handleMessagesDeleted: (guildId, channelId, messageIds): void => {
      void cards.handleMessagesDeleted(guildId, channelId, messageIds).catch(logFailure("Campaign card recovery after a deleted message failed", guildId));
    },
    handleChannelDeleted: (guildId, channelId): void => {
      void recoverChannel(guildId, channelId).catch(logFailure("Campaign channel recovery failed", guildId));
    },
    start: async (): Promise<void> => {
      openStore();
      // Portrait drafts a player walked away from are let go after a day.
      void portraitStore.sweepDrafts(24 * 60 * 60 * 1000).catch(logFailure("Portrait drafts could not be cleaned up", "-"));
      await postgresStore?.ready();
      // Adventures a server approved are readable again before any game needs them.
      const loaded = await catalog.load();
      if (loaded.skipped.length > 0) logger.warn({ skipped: loaded.skipped }, "Some approved adventures no longer parse and were skipped");
      const report = await running.start();
      logger.info({ modelConfigured: model !== null, paused: report.paused.length, firstRoundsOpened: report.firstRoundsOpened.length, roundsReopened: report.roundsReopened.length }, "Campaign runtime started");
      // Cards deleted while the bot was away come back; this needs Discord, so it does not hold up startup.
      cardRecovery = cards.recoverAll()
        .catch((error: unknown) => logger.error({ err: error }, "Campaign card recovery at startup failed"))
        .finally(() => { cardRecovery = null; });
      reconcileTimer = setInterval(reconcileCards, 60_000);
      reconcileTimer.unref();
    },
    stop: async (): Promise<void> => {
      if (reconcileTimer !== null) clearInterval(reconcileTimer);
      reconcileTimer = null;
      await cardRecovery;
      await cardReconciliation;
      await running.stop();
      if (database?.open === true) database.close();
      await postgres?.close();
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
  narrateTrade: () => Promise.reject(new Error("CAMPAIGN_MODEL is not configured.")),
  narrateDialogue: () => Promise.reject(new Error("CAMPAIGN_MODEL is not configured.")),
  narrateUtilityCast: () => Promise.reject(new Error("CAMPAIGN_MODEL is not configured.")),
  narrateHazard: () => Promise.reject(new Error("CAMPAIGN_MODEL is not configured.")),
};
