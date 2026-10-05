import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ActivityTableService } from "../infrastructure/activity/activity-table-service.js";
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
import { buildClasses, classTemplates, selectableBuildRaces, suggestedAbilities, type BuildChoices } from "../domain/campaign/character/character-build.js";
import { skills } from "../domain/campaign/rules/skills.js";
import { houseRulePresets } from "../domain/campaign/rules/house-rules.js";
import { isTimeOfDay, isWeather, type TimeOfDay, type Weather } from "../domain/campaign/rules/world-rules.js";
import { CampaignLobbyService, type ActivityCampaignListingItem, type ServiceResult } from "../application/campaign/campaign-lobby-service.js";
import { CampaignPlayController, type PlayResult } from "../application/campaign/campaign-play-controller.js";
import { buildActivityLobbyView, buildActivityTableView, canSeeActivityCampaign, type ActivityGameView } from "../application/campaign/activity-view.js";
import { libraryHeroRef } from "../application/campaign/library/library-types.js";
import { CampaignRuntime } from "../application/campaign/campaign-runtime.js";
import { LlmCampaignChronicler } from "../application/campaign/dm/llm-chronicler.js";
import { LlmCampaignNarrator, LlmCampaignPlanner } from "../application/campaign/dm/llm-dm.js";
import { LlmSceneNoteJudge } from "../application/campaign/dm/llm-scene-note-judge.js";
import type { CampaignNarrator, CampaignPlanner } from "../application/campaign/ports/dm-ports.js";
import type { CampaignKey, CampaignTransaction, CampaignUnitOfWork } from "../application/campaign/ports/campaign-store.js";
import type { CampaignRecord } from "../application/campaign/ports/campaign-record.js";
import type { CharacterId, UserId } from "../domain/campaign/core/ids.js";
import type { ContentId } from "../domain/campaign/rules/content-id.js";
import type { StructuredModelClient } from "../application/campaign/ports/structured-model-client.js";
import { CryptoRandomSource } from "../application/campaign/random/crypto-random-source.js";
import { RulesetCatalog } from "../application/campaign/rules/ruleset-catalog.js";
import { SystemClock } from "../application/campaign/time/system-clock.js";
import { DeliveryWorker } from "../application/campaign/workers/delivery-worker.js";
import type { CampaignIcons } from "../infrastructure/discord/campaign/campaign-icons.js";
import { ImageWorker } from "../application/campaign/workers/image-worker.js";
import { monsterGalleryImage } from "../infrastructure/campaign/image/monster-gallery.js";
import { FileImageAssetStore } from "../infrastructure/campaign/image/file-image-asset-store.js";
import { HeroPictures } from "../infrastructure/discord/campaign/hero-pictures.js";
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
import { abilities, type Ability } from "../domain/campaign/rules/effects.js";
import { GeminiStructuredClient } from "../infrastructure/campaign/llm/gemini-structured-client.js";
import { OpenAiCompatibleStructuredClient } from "../infrastructure/campaign/llm/openai-compatible-structured-client.js";
import { OpenAiResponsesStructuredClient } from "../infrastructure/campaign/llm/openai-responses-structured-client.js";
import { loadBundledAdventures, loadStarterAdventure, starterAdventureId } from "../infrastructure/campaign/starter-adventures.js";
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
import { maxActionLength } from "../domain/campaign/engine/rounds.js";
import { maxSpeechLength } from "../domain/campaign/engine/speech.js";
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
  // Whether one of these channels (a message's own and, in a thread, its parent) is a game's Party or Adventure post.
  isGameChannel(guildId: string, channelIds: readonly string[]): Promise<boolean>;
  readonly activity: {
    readonly portraits: CharacterPortraits;
    readonly tables: ActivityTableService;
    characterCatalog(): unknown;
    listCharacters(userId: UserId): Promise<unknown>;
    getCharacter(userId: UserId, characterId: string): Promise<unknown | null>;
    characterPortrait(userId: UserId, characterId: string): Promise<{ readonly bytes: Buffer; readonly mediaType: "image/png" | "image/jpeg" | "image/webp" } | null>;
    createCharacter(userId: UserId, build: BuildChoices): Promise<{ readonly kind: "ok"; readonly characterId: string } | { readonly kind: "invalid"; readonly problems: readonly { readonly code: string }[] } | { readonly kind: "full" }>;
    editCharacter(userId: UserId, characterId: string, build: BuildChoices): Promise<{ readonly kind: "ok" } | { readonly kind: "invalid"; readonly problems: readonly { readonly code: string }[] } | { readonly kind: "notFound" }>;
    deleteCharacter(userId: UserId, characterId: string): Promise<boolean>;
    listGames(guildId: string, userId: UserId): Promise<readonly ActivityCampaignListingItem[]>;
    gameForChannel(guildId: string, userId: UserId, channelId: string): Promise<ActivityCampaignListingItem | null>;
    joinLobby(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>>;
    requestJoin(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>>;
    withdrawJoin(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>>;
    snapshot(key: CampaignKey, userId: UserId, since?: string): Promise<{ readonly kind: "ok"; readonly value: ActivityGameView; readonly token: string } | { readonly kind: "unchanged"; readonly token: string } | { readonly kind: "refused"; readonly reason: "notFound" | "notActive" | "privateInviteOnly" }>;
    act(key: CampaignKey, userId: UserId, input: unknown): Promise<{ readonly kind: "ok" } | { readonly kind: "refused"; readonly reason: string }>;
    image(key: CampaignKey, userId: UserId, kind: "scene" | "character" | "encounter", id: string): Promise<{ readonly bytes: Buffer; readonly mediaType: "image/png" | "image/jpeg" | "image/webp" } | null>;
  };
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
  // The game icons on buttons and menus (from the bot's application emoji); without them everything is text.
  readonly icons?: CampaignIcons;
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
  // The bundled adventures plus every adventure a server approved.
  const starter = loadStarterAdventure();
  const adventures = new UploadedAdventureLibrary(new StaticAdventureLibrary(loadBundledAdventures()));
  const clock = new SystemClock();

  let runtime: CampaignRuntime | null = null;
  const bus = new CampaignCommandBus({ unitOfWork, rulesets, clock, onWorkQueued: (): void => runtime?.kick() });

  const messages = new DiscordMessageGateway(client, input.icons);
  const issues = new CampaignIssues({ unitOfWork, clock, notify: organizerNotice(messages) });
  const resources = new DiscordResourceGateway(client);
  const library = new CharacterLibrary({ unitOfWork, clock, content, rulesetVersion: content.version });
  // A saved character's portrait: an upload turned into D&D art, or one painted from its description.
  // Both need the image model; without it the portrait screens are simply not offered.
  const portraitStore = new FilePortraitStore(resolve(configuration.runtimeDataDirectory, "character-portraits"));
  const portraits = new CharacterPortraits({
    library,
    store: portraitStore,
    clock,
    ...configuration.portraitGenerationLimit,
    ...(configuration.campaignImages === null || configuration.campaignImages === undefined
      ? {}
      : { stylizer: new OpenAiImageStylizer(configuration.campaignImages), generator: new OpenAiImageGenerator(configuration.campaignImages) }),
  });
  // Each hero's thumbnail on the party channel and portrait on their sheet: their saved character's portrait, or their initials.
  const heroPictures = new HeroPictures({ portraitFor: (libraryCharacterId): ReturnType<typeof portraits.forGame> => portraits.forGame(libraryCharacterId) });
  const cards = new CampaignCardService({ unitOfWork, rulesets, adventures, messages, glossaries, logger, issues, resources, pictures: heroPictures, drawMap: true, activity: configuration.activity?.enabled === true });
  const presenter = new DiscordCampaignPresenter({ unitOfWork, messages, cards, adventures, glossaries });
  const imageAssets = new FileImageAssetStore(resolve(configuration.runtimeDataDirectory, "campaign-images"));
  const lobby = new CampaignLobbyService({
    unitOfWork,
    library,
    rulesets,
    bus,
    adventures,
    clock,
    ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
    // A players-only game hides its channels once it starts.
    onEnded: (key): void => {
      void imageAssets.removeAll(key).catch(logFailure("Leftover campaign pictures could not be removed", key.guildId));
    },
    onStarted: (key): void => {
      void setup.applyVisibility(key).catch(logFailure("Campaign visibility could not be applied", key.guildId));
    },
  });
  const play = new CampaignPlayController({ unitOfWork, bus, refresher: cards, adventures });
  // Activity writes use the same command bus and engine checks, but redraws
  // the Activity itself instead of also editing Discord cards on every click.
  const activityPlay = new CampaignPlayController({ unitOfWork, bus, refresher: { refresh: (): void => {} }, adventures });
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
    dm: new DmJobWorker({ unitOfWork, bus, planner, narrator, ...(model === null ? {} : { chronicler: new LlmCampaignChronicler({ client: model, cacheKey }), noteJudge: new LlmSceneNoteJudge({ client: model, cacheKey }) }), adventures, glossaries, rulesets, logger }),
    delivery: new DeliveryWorker(unitOfWork, presenter, {
      clock,
      onAbandoned: async (key, item): Promise<void> => {
        await issues.raise(key, "deliveryFailed", item.request.kind === "deliver" ? item.request.delivery.kind : item.request.kind);
      },
    }),
    queuedJoins: { runOnce: () => lobby.processQueuedJoins() },
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
            assets: imageAssets,
            portraits,
          }),
        }),
    logger,
    bootId: randomUUID(),
  });
  const running = runtime;

  const authority = new CampaignAuthority(input.accessPolicyService, unitOfWork);
  const creator = new CampaignGameCreator({ lobby, setup, defaultAdventureId: starterAdventureId, modelConfigured: model !== null, adventures });
  const tables = new ActivityTableService({
    unitOfWork, lobby, creator, adventures, now: (): number => clock.now(), refresh: (key): void => cards.refresh(key),
    isAdmin: async (guildId, userId): Promise<boolean> => {
      const guild = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch({ user: userId, force: true });
      const settings = await unitOfWork.transaction((tx) => tx.loadGuildSettings(guildId));
      return authority.isActivityAdmin({ guildId, userId, channelId: settings?.hubChannelId ?? guildId, roleIds: [...member.roles.cache.keys()], memberPermissions: member.permissions.bitfield, botPermissions: guild.members.me?.permissions.bitfield ?? null });
    },
    isMember: async (guildId, userId): Promise<boolean> => {
      const guild = await client.guilds.fetch(guildId);
      return guild.members.fetch({ user: userId, force: true }).then((member) => !member.user.bot, () => false);
    },
    searchMembers: async (guildId, query): Promise<readonly { userId: string; displayName: string }[]> => {
      const guild = await client.guilds.fetch(guildId);
      const members = await guild.members.search({ query, limit: 10 });
      return [...members.values()].filter((member) => !member.user.bot).map((member) => ({ userId: member.id, displayName: member.displayName }));
    },
    memberName: async (guildId, userId): Promise<string> => {
      const guild = await client.guilds.fetch(guildId);
      return guild.members.fetch(userId).then((member) => member.displayName, () => userId);
    },
  });
  const libraryHandler = new CharacterLibraryComponentHandler({
    library,
    content,
    glossaries,
    portraits,
    onPortraitChanged: async (libraryCharacterId): Promise<void> => {
      try {
        const active = await unitOfWork.transaction(async (tx) => {
          const records = await tx.listRecordsByLifecycle(["active", "paused"]);
          const matches = [];
          for (const { record } of records) {
            const campaign = await tx.loadCampaign(record.key);
            if (campaign !== undefined && Object.values(campaign.state.characters).some((sheet) => sheet.origin?.libraryCharacterId === libraryCharacterId)) matches.push(record.key);
          }
          return matches;
        });
        for (const key of active) {
          try {
            await cards.sync(key);
          } catch (error) {
            logger.warn({ err: error, guildId: key.guildId, campaignId: key.campaignId }, "Party portrait refresh failed");
          }
        }
      } catch (error) {
        logger.warn({ err: error, libraryCharacterId }, "Party portrait refresh lookup failed");
      }
    },
  });
  const catalog = new AdventureCatalog({ unitOfWork, clock, content, library: adventures });
  // The Author never writes heroes: it borrows the bundled adventure's, in the language asked for.
  const author = model === null ? null : new AdventureAuthor({ client: model, content, heroesFor: (language): typeof starter.en.heroes => starter[language].heroes });
  const intake = new AdventureIntake({ catalog, author, glossaries });
  const adventureHandler = new AdventureComponentHandler({ catalog, authority, glossaries, example: (language): string => readFileSync(fileURLToPath(new URL(`../../assets/campaign/adventures/moonlit-ruins/${language}.yaml`, import.meta.url)), "utf8") });
  const command = new DndCommand({ lobby, play, setup, cards, creator, authority, library, libraryScreens: libraryHandler, intake });
  const handler = new CampaignComponentHandler({ lobby, play, cards, unitOfWork, rulesets, adventures, glossaries, library, pictures: heroPictures, ...(input.icons === undefined ? {} : { icons: input.icons }) });
  const hubHandler = new CampaignHubComponentHandler({ lobby, play, setup, cards, creator, authority, adventures, libraryScreens: libraryHandler, intake, imagesEnabled: configuration.campaignImages !== null && configuration.campaignImages !== undefined, ...(input.icons === undefined ? {} : { icons: input.icons }) });

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
    settings: new CampaignSettingsAccess({ unitOfWork, lobby, setup, cards, modelConfigured: model !== null }),
    isGameChannel: async (guildId, channelIds) => (await lobby.findByChannel(guildId, channelIds)) !== undefined,
    activity: {
      tables,
      characterCatalog: () => ({ races: selectableBuildRaces, skills, classes: buildClasses.map((id) => ({ id, skillChoices: classTemplates[id].skillChoices, skillCount: classTemplates[id].skillCount, expertiseCount: classTemplates[id].expertiseCount, kits: classTemplates[id].kits.map((kit) => kit.id), suggestedAbilities: suggestedAbilities(id) })) }),
      listCharacters: async (userId) => (await library.list(userId)).flatMap((entry) => entry.snapshots.filter((snapshot) => snapshot.branch === "main").sort((a, b) => a.revision - b.revision).slice(-1).map((snapshot) => ({ id: entry.character.id, snapshotId: snapshot.id, name: entry.character.name, className: entry.character.className, race: snapshot.build.race ?? null, versionCount: entry.snapshots.filter((version) => version.branch === "main").length }))),
      getCharacter: async (userId, characterId) => {
        const entry = await library.entry(userId, characterId);
        if (entry === undefined) return null;
        return { id: entry.character.id, name: entry.character.name, versions: [...entry.snapshots].sort((a, b) => a.revision - b.revision).map((snapshot) => ({ id: snapshot.id, revision: snapshot.revision, branch: snapshot.branch, source: snapshot.source.kind, createdAt: snapshot.createdAt, build: snapshot.build, gear: snapshot.gear, progression: snapshot.progression ?? null })) };
      },
      characterPortrait: async (userId, characterId) => (await portraits.current(userId, characterId)) ?? null,
      portraits,
      createCharacter: async (userId, build) => {
        const result = await library.create(userId, build);
        return result.kind === "ok" ? { kind: "ok" as const, characterId: result.character.id } : result;
      },
      editCharacter: async (userId, characterId, build) => {
        const result = await library.edit(userId, characterId, build);
        return result.kind === "ok" ? { kind: "ok" as const } : result;
      },
      deleteCharacter: (userId, characterId) => library.remove(userId, characterId),
      listGames: (guildId, userId): Promise<readonly ActivityCampaignListingItem[]> => lobby.activityGames(guildId, userId),
      gameForChannel: (guildId, userId, channelId): Promise<ActivityCampaignListingItem | null> => lobby.activityGameForChannel(guildId, userId, channelId),
      joinLobby: (key, userId): Promise<ServiceResult<CampaignRecord>> => lobby.joinFromActivity(key, userId),
      requestJoin: (key, userId): Promise<ServiceResult<CampaignRecord>> => lobby.requestOngoingJoin(key, userId),
      withdrawJoin: (key, userId): Promise<ServiceResult<CampaignRecord>> => lobby.withdrawOngoingJoin(key, userId),
      snapshot: async (key, userId, since) => {
        return unitOfWork.transaction(async (tx) => {
        const storedRecord = await tx.loadRecord(key);
        if (storedRecord === undefined) return { kind: "refused", reason: "notFound" } as const;
        const storedCampaign = await tx.loadCampaign(key);
        if (!canSeeActivityCampaign(storedRecord.record, storedCampaign?.state, userId, clock.now())) {
          return { kind: "refused", reason: "privateInviteOnly" } as const;
        }
        // Both revisions move with every change to the game; a client that already holds this one is told so instead of being sent it again.
        const token = `${storedRecord.revision}.${storedCampaign?.revision ?? 0}`;
        if (since === token) return { kind: "unchanged", token } as const;
        const savedHeroChoices = (await library.listInTransaction(tx, userId)).flatMap((entry) => entry.snapshots.filter((snapshot) => snapshot.branch === "main").slice(-1).map((snapshot) => ({ id: libraryHeroRef(snapshot.id), name: entry.character.name, className: entry.character.className, imageUrl: `/api/activity/characters/${encodeURIComponent(entry.character.id)}/portrait` })));
        const adventure = adventures.documentAt(storedRecord.record.adventure.adventureId, storedRecord.record.adventure.version, storedRecord.record.language);
        if (adventure === undefined) return { kind: "refused", reason: "notFound" } as const;
        if (storedRecord.record.lifecycle === "lobby") {
          return { kind: "ok", value: buildActivityLobbyView(storedRecord.record, adventure.bible, userId, adventure.heroes, savedHeroChoices, clock.now()), token } as const;
        }
        if ((storedRecord.record.lifecycle !== "active" && storedRecord.record.lifecycle !== "paused") || storedCampaign === undefined) {
          return { kind: "refused", reason: "notActive" } as const;
        }
        const events = (await tx.readEvents(key)).map((envelope) => envelope.event);
        return {
          kind: "ok",
          value: buildActivityTableView(storedRecord.record, storedCampaign.state, adventure.bible, content, glossaries[storedRecord.record.language], userId, adventure.heroes, clock.now(), savedHeroChoices, events),
          token,
        } as const;
        });
      },
      image: async (key, userId, kind, id) => {
        const owner = await unitOfWork.transaction(async (tx) => {
          const storedRecord = await tx.loadRecord(key);
          const storedCampaign = await tx.loadCampaign(key);
          if (storedRecord === undefined || !canSeeActivityCampaign(storedRecord.record, storedCampaign?.state, userId, clock.now()) || storedCampaign === undefined) return null;
          if (kind === "scene") return storedCampaign.state.sceneId === id ? { kind, id } : null;
          if (kind === "encounter") return storedCampaign.state.encounter?.id === id && storedCampaign.state.encounter.status !== "ended" ? { kind, id } : null;
          const character = storedCampaign.state.characters[id];
          const isPartyMember = Object.values(storedCampaign.state.members).some((member) => member.characterId === id);
          const libraryCharacterId = character?.origin?.libraryCharacterId;
          return isPartyMember ? { kind, id, libraryCharacterId } : null;
        });
        if (owner === null) return null;
        if (kind === "scene") return (await imageAssets.load(key, owner.id)) ?? null;
        if (kind === "encounter") return (await imageAssets.load(key, `encounter:${owner.id}`)) ?? null;
        const generated = await imageAssets.load(key, `hero:${owner.id}`);
        return generated ?? (owner.libraryCharacterId === undefined ? null : (await portraits.forGame(owner.libraryCharacterId)) ?? null);
      },
      act: async (key, userId, input) => {
        if (typeof input !== "object" || input === null || !("kind" in input) || typeof input.kind !== "string") {
          return { kind: "refused", reason: "invalidAction" };
        }
        const action = input as Record<string, unknown>;
        const id = randomUUID();
        const textValue = (value: unknown, max = 128): string | null => typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : null;
        const integerValue = (value: unknown, min = 0, max = 9): number | null => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
        const stringList = (value: unknown): string[] | null => Array.isArray(value) && value.length > 0 && value.length <= 6 && value.every((item) => typeof item === "string" && item.length <= 128) ? value : null;
        switch (action.kind) {
          case "chooseHero": {
            const heroId = textValue(action.heroId);
            if (heroId === null) return { kind: "refused", reason: "invalidAction" };
            return lobby.chooseHero(key, userId, heroId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          }
          case "joinLobby": return lobby.joinFromActivity(key, userId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          case "leaveLobby": return lobby.leave(key, userId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          case "requestJoin": return lobby.requestOngoingJoin(key, userId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          case "chooseSaved": {
            const snapshotId = textValue(action.snapshotId);
            if (snapshotId === null) return { kind: "refused", reason: "invalidAction" };
            const result = await lobby.chooseSaved(key, userId, snapshotId);
            return result.kind === "ok" ? { kind: "ok" } : { kind: "refused", reason: result.kind === "conflicts" ? "characterIncompatible" : result.reason };
          }
          case "startLobby": {
            const result = await lobby.start(key, userId);
            return result.kind === "ok" ? { kind: "ok" } : { kind: "refused", reason: result.reason };
          }
          case "acceptInvite": return lobby.acceptOngoingInvite(key, userId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          case "joinHero": {
            const heroRef = textValue(action.heroRef);
            if (heroRef === null) return { kind: "refused", reason: "invalidAction" };
            return lobby.joinOngoingHero(key, userId, heroRef, id).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          }
          // A player whose hero has fallen takes a new one (the engine and the lobby record both learn of it).
          case "replaceHero": {
            const heroRef = textValue(action.heroRef);
            if (heroRef === null) return { kind: "refused", reason: "invalidAction" };
            const entrance = typeof action.entrance === "string" ? action.entrance.slice(0, 600) : undefined;
            return lobby.replaceFallenHero(key, userId, heroRef, entrance, id).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          }
          case "retireSeat": {
            const target = textValue(action.userId, 64);
            if (target === null) return { kind: "refused", reason: "invalidAction" };
            return lobby.retireSeat(key, userId, target as UserId, id).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          }
          case "withdrawJoin": return lobby.withdrawOngoingJoin(key, userId).then((result) => result.kind === "ok" ? { kind: "ok" as const } : { kind: "refused" as const, reason: result.reason });
          case "submit": {
            const text = textValue(action.text, maxActionLength);
            if (text === null) return { kind: "refused", reason: "invalidAction" };
            const roundNumber = typeof action.roundNumber === "number" && Number.isInteger(action.roundNumber) ? action.roundNumber : undefined;
            const sceneId = textValue(action.sceneId, 200) ?? undefined;
            return activityPlay.submitAction(key, userId, text, id, roundNumber, sceneId).then(mapPlayResult);
          }
          case "speak": {
            const text = textValue(action.text, maxSpeechLength);
            if (text === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.speak(key, userId, text, id).then(mapPlayResult);
          }
          case "pass": return activityPlay.pass(key, userId, id).then(mapPlayResult);
          case "away": return activityPlay.away(key, userId, id).then(mapPlayResult);
          case "back": return activityPlay.back(key, userId, id).then(mapPlayResult);
          case "toggleMoveObjection": return activityPlay.toggleMoveObjection(key, userId, id).then(mapPlayResult);
          case "moveVote": {
            if (action.choice !== "go" && action.choice !== "stay") return { kind: "refused", reason: "invalidAction" };
            return activityPlay.voteOnMove(key, userId, action.choice, id).then(mapPlayResult);
          }
          case "roll": return activityPlay.roll(key, userId, id).then(mapPlayResult);
          case "ready": return activityPlay.ready(key, userId, id).then(mapPlayResult);
          case "begin": return activityPlay.begin(key, userId, id).then(mapPlayResult);
          case "continue": return activityPlay.continue(key, userId, id).then(mapPlayResult);
          case "attack": {
            const targetId = textValue(action.targetId);
            const weaponId = textValue(action.weaponId);
            if (targetId === null || weaponId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatAttack", combatantId: characterId, targetId, weapon: weaponId as ContentId<"item">, ...(action.offHand === true ? { offHand: true as const } : {}), ...(action.nonlethal === true ? { nonlethal: true as const } : {}) })).then(mapPlayResult);
          }
          case "move": {
            const zoneId = textValue(action.zoneId);
            if (zoneId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatMove", combatantId: characterId, zoneId })).then(mapPlayResult);
          }
          case "engage": {
            const targetId = textValue(action.targetId);
            if (targetId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatEngage", combatantId: characterId, targetId })).then(mapPlayResult);
          }
          case "withdraw": return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatWithdraw", combatantId: characterId })).then(mapPlayResult);
          case "dash": return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatDash", combatantId: characterId })).then(mapPlayResult);
          case "disengage": return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatDisengage", combatantId: characterId })).then(mapPlayResult);
          case "feature": {
            const featureId = textValue(action.featureId);
            if (featureId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatUseFeature", combatantId: characterId, featureId: featureId as ContentId<"feature"> })).then(mapPlayResult);
          }
          case "combatItem": {
            const itemId = textValue(action.itemId);
            if (itemId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatUseItem", combatantId: characterId, itemId: itemId as ContentId<"item"> })).then(mapPlayResult);
          }
          case "shield": {
            const itemId = textValue(action.itemId);
            if (itemId === null || typeof action.on !== "boolean") return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatShield", combatantId: characterId, itemId: itemId as ContentId<"item">, on: action.on as boolean })).then(mapPlayResult);
          }
          case "wildShape": {
            const monsterId = action.monsterId === null ? null : textValue(action.monsterId);
            if (action.monsterId !== null && monsterId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatWildShape", combatantId: characterId, ...(monsterId === null ? {} : { monsterId: monsterId as ContentId<"monster"> }) })).then(mapPlayResult);
          }
          case "moveScene": {
            const sceneId = textValue(action.sceneId);
            if (sceneId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.proposeMove(key, userId, sceneId, id).then(mapPlayResult);
          }
          case "endTurn": return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "endTurn", combatantId: characterId })).then(mapPlayResult);
          case "combatDodge": return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatDodge", combatantId: characterId })).then(mapPlayResult);
          case "combatSpell": {
            const spellId = textValue(action.spellId);
            const slotLevel = integerValue(action.slotLevel);
            const targetIds = stringList(action.targetIds);
            if (spellId === null || slotLevel === null || targetIds === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatCast", combatantId: characterId, spellId: spellId as ContentId<"spell">, slotLevel, targetIds })).then(mapPlayResult);
          }
          case "teleport": {
            const spellId = textValue(action.spellId);
            const slotLevel = integerValue(action.slotLevel);
            const zoneId = textValue(action.zoneId);
            if (spellId === null || slotLevel === null || zoneId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatCast", combatantId: characterId, spellId: spellId as ContentId<"spell">, slotLevel, targetIds: [characterId], zoneId })).then(mapPlayResult);
          }
          case "exploreSpell": {
            const spellId = textValue(action.spellId);
            if (spellId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.castSpell(key, userId, spellId as ContentId<"spell">, id).then(mapPlayResult);
          }
          // Stopping play is for every player; pausing and resting are the organizer's (the engine refuses anyone else).
          case "safetyStop": return activityPlay.safety(key, userId, id).then(mapPlayResult);
          case "pause": return activityPlay.pause(key, userId, id).then(mapPlayResult);
          case "queueRest": {
            const rest = action.rest === "short" || action.rest === "long" ? action.rest : action.rest === "none" ? null : undefined;
            if (rest === undefined) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.queueRest(key, userId, rest, id).then(mapPlayResult);
          }
          case "proposeRest": {
            if (action.rest !== "short" && action.rest !== "long") return { kind: "refused", reason: "invalidAction" };
            return activityPlay.proposeRest(key, userId, action.rest, id).then(mapPlayResult);
          }
          case "answerRestVote": {
            if (typeof action.agree !== "boolean") return { kind: "refused", reason: "invalidAction" };
            return activityPlay.answerRestVote(key, userId, action.agree, id).then(mapPlayResult);
          }
          case "dismissCompanion": {
            const companionId = textValue(action.companionId);
            if (companionId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.dismissCompanion(key, userId, companionId, id).then(mapPlayResult);
          }
          case "setProxy": {
            const proxyUserId = action.userId === null ? null : textValue(action.userId);
            if (action.userId !== null && proxyUserId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.proxy(key, userId, proxyUserId as UserId | null, id).then(mapPlayResult);
          }
          case "runGame": {
            const verb = textValue(action.verb, 32);
            if (verb === null || !["closeRound", "retry", "retryFight", "retell", "illustrate", "illustrateScene"].includes(verb)) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.manage(key, verb as "closeRound" | "retry" | "retryFight" | "retell" | "illustrate" | "illustrateScene", id, userId).then(mapPlayResult);
          }
          case "raiseLevel": {
            const level = integerValue(action.level);
            if (level === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.raiseLevel(key, userId, level, id).then(mapPlayResult);
          }
          case "setWorld": {
            const day = action.day === undefined ? undefined : integerValue(action.day);
            const time = action.time === undefined || action.time === "" ? undefined : textValue(action.time, 16);
            const weather = action.weather === undefined || action.weather === "" ? undefined : textValue(action.weather, 16);
            const note = action.note === undefined || action.note === "" ? undefined : textValue(action.note, 200);
            if (day === null || (time !== undefined && (time === null || !isTimeOfDay(time))) || (weather !== undefined && (weather === null || (weather !== "none" && !isWeather(weather)))) || note === null) return { kind: "refused", reason: "invalidAction" };
            if (day === undefined && time === undefined && weather === undefined) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.setWorld(key, userId, { ...(day === undefined ? {} : { day }), ...(time === undefined ? {} : { time: time as TimeOfDay }), ...(weather === undefined ? {} : { weather: weather === "none" ? null : (weather as Weather) }), ...(note === undefined ? {} : { note }) }, id).then(mapPlayResult);
          }
          case "saveProgress": {
            const saved = await library.saveProgress(userId, key);
            if (saved.kind === "refused") return { kind: "refused", reason: saved.reason };
            return { kind: "ok" };
          }
          case "setHouseRule": {
            const ruleId = textValue(action.ruleId, 64);
            const value = textValue(action.value, 64);
            if (ruleId === null || value === null) return { kind: "refused", reason: "invalidAction" };
            return lobby.setHouseRules(key, userId, { [ruleId]: value }).then((result) => (result.kind === "refused" ? { kind: "refused" as const, reason: result.reason } : { kind: "ok" as const }));
          }
          case "applyRulePreset": {
            const presetId = textValue(action.presetId, 32);
            const preset = houseRulePresets.find((candidate) => candidate.id === presetId);
            if (preset === undefined) return { kind: "refused", reason: "invalidAction" };
            return lobby.setHouseRules(key, userId, preset.values).then((result) => (result.kind === "refused" ? { kind: "refused" as const, reason: result.reason } : { kind: "ok" as const }));
          }
          case "reopen": return lobby.reopen(key, userId).then((result) => (result.kind === "refused" ? { kind: "refused" as const, reason: result.reason } : { kind: "ok" as const }));
          case "spendHitDice": {
            const count = integerValue(action.count);
            if (count === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.spendHitDice(key, userId, count, id).then(mapPlayResult);
          }
          // Level-up choices. The engine checks every one (an improvement owed, the cap of 20, a class the hero qualifies for).
          case "chooseAsi": {
            const first = textValue(action.plusTwo, 3);
            const pair = Array.isArray(action.plusOne) ? action.plusOne.map((entry) => textValue(entry, 3)) : [];
            const isAbility = (value: string | null): value is Ability => value !== null && (abilities as readonly string[]).includes(value);
            if (isAbility(first)) return activityPlay.chooseAsi(key, userId, { plusTwo: first }, id).then(mapPlayResult);
            const [one, two] = pair;
            if (pair.length === 2 && isAbility(one ?? null) && isAbility(two ?? null)) return activityPlay.chooseAsi(key, userId, { plusOne: [one as Ability, two as Ability] }, id).then(mapPlayResult);
            return { kind: "refused", reason: "invalidAction" };
          }
          case "chooseClassLevel": {
            const buildClass = textValue(action.buildClass, 32);
            if (buildClass === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.chooseClassLevel(key, userId, buildClass, textValue(action.skill, 32) ?? undefined, id).then(mapPlayResult);
          }
          case "chooseFightingStyle": {
            const styleId = textValue(action.styleId);
            if (styleId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.chooseFightingStyle(key, userId, styleId, id).then(mapPlayResult);
          }
          case "chooseWarlockOptions": {
            const invocations = Array.isArray(action.invocations) ? action.invocations.flatMap((entry) => textValue(entry) ?? []) : undefined;
            const pactBoon = textValue(action.pactBoon) ?? undefined;
            if (invocations === undefined && pactBoon === undefined) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.chooseWarlockOptions(key, userId, { ...(invocations === undefined ? {} : { invocations }), ...(pactBoon === undefined ? {} : { pactBoon }) }, id).then(mapPlayResult);
          }
          case "healSpell":
          case "reviveSpell": {
            const spellId = textValue(action.spellId);
            const slotLevel = integerValue(action.slotLevel);
            const targetId = textValue(action.targetId);
            if (spellId === null || slotLevel === null || targetId === null) return { kind: "refused", reason: "invalidAction" };
            const result = action.kind === "healSpell"
              ? await activityPlay.healSpell(key, userId, spellId as ContentId<"spell">, slotLevel, targetId, id)
              : await activityPlay.reviveSpell(key, userId, spellId as ContentId<"spell">, slotLevel, targetId, id);
            return mapPlayResult(result);
          }
          case "summonCompanion": {
            const spellId = textValue(action.spellId);
            const slotLevel = integerValue(action.slotLevel);
            if (spellId === null || slotLevel === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.summonCompanion(key, userId, spellId as ContentId<"spell">, slotLevel, id).then(mapPlayResult);
          }
          case "askNpc": {
            const npcId = textValue(action.npcId);
            const question = textValue(action.question, 500);
            if (npcId === null || question === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.ask(key, userId, npcId, question, id).then(mapPlayResult);
          }
          case "pressNpc": {
            const npcId = textValue(action.npcId);
            const skill = textValue(action.skill, 32);
            if (npcId === null || !["insight", "persuasion", "deception", "intimidation"].includes(skill ?? "")) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.press(key, userId, npcId, skill as "insight" | "persuasion" | "deception" | "intimidation", id).then(mapPlayResult);
          }
          case "shop": {
            const npcId = textValue(action.npcId);
            const itemId = textValue(action.itemId);
            if (npcId === null || itemId === null || (action.direction !== "buy" && action.direction !== "sell")) return { kind: "refused", reason: "invalidAction" };
            // A skill to haggle with; empty or absent pays the list price.
            const haggle = textValue(action.haggle, 32);
            if (haggle !== null && haggle !== "" && !["persuasion", "deception", "intimidation"].includes(haggle)) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.trade(key, userId, { npcId, itemId: itemId as ContentId<"item">, direction: action.direction, ...(haggle === null || haggle === "" ? {} : { haggle: haggle as "persuasion" | "deception" | "intimidation" }) }, id).then(mapPlayResult);
          }
          case "useItem": {
            const itemId = textValue(action.itemId);
            if (itemId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.useItem(key, userId, itemId as ContentId<"item">, id).then(mapPlayResult);
          }
          case "stashItem":
          case "takeFromStash": {
            const itemId = textValue(action.itemId);
            if (itemId === null) return { kind: "refused", reason: "invalidAction" };
            const result = action.kind === "stashItem"
              ? await activityPlay.stash(key, userId, itemId as ContentId<"item">, id)
              : await activityPlay.takeFromStash(key, userId, itemId as ContentId<"item">, id);
            return mapPlayResult(result);
          }
          case "giveItem": {
            const itemId = textValue(action.itemId);
            const toCharacterId = textValue(action.toCharacterId);
            if (itemId === null || toCharacterId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.give(key, userId, itemId as ContentId<"item">, toCharacterId as CharacterId, id).then(mapPlayResult);
          }
          case "offerResponse": {
            const offerId = textValue(action.offerId);
            const answer = action.answer;
            if (offerId === null || (answer !== "accept" && answer !== "decline" && answer !== "cancel")) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.answerOffer(key, userId, offerId, answer, id).then(mapPlayResult);
          }
          case "wearItem":
          case "removeItem": {
            const itemId = textValue(action.itemId);
            if (itemId === null) return { kind: "refused", reason: "invalidAction" };
            const result = action.kind === "wearItem"
              ? await activityPlay.wear(key, userId, itemId as ContentId<"item">, id)
              : await activityPlay.remove(key, userId, itemId as ContentId<"item">, id);
            return mapPlayResult(result);
          }
          case "reaction": {
            const spellId = action.spellId === null ? null : textValue(action.spellId);
            const slotLevel = action.slotLevel === null ? null : integerValue(action.slotLevel);
            if (action.spellId !== null && (spellId === null || slotLevel === null)) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatReact", combatantId: characterId, spellId: spellId as ContentId<"spell"> | null })).then(mapPlayResult);
          }
          case "smite": {
            const slotLevel = action.slotLevel === null ? null : integerValue(action.slotLevel);
            if (action.slotLevel !== null && slotLevel === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatSmite", combatantId: characterId, slotLevel })).then(mapPlayResult);
          }
          case "opportunityAttack": {
            const targetId = textValue(action.targetId);
            if (action.accept === true && targetId === null) return { kind: "refused", reason: "invalidAction" };
            return activityPlay.combat(key, userId, id, (characterId) => ({ kind: "combatOpportunityAttack", combatantId: characterId, take: action.accept === true })).then(mapPlayResult);
          }
          default: return { kind: "refused", reason: "invalidAction" };
        }
      },
    },
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
      // Servers set up before players were barred from typing in game channels are locked now.
      void setup.lockAllGuilds().catch(logFailure("Game channels could not be locked to players at startup", "-"));
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

function mapPlayResult(result: PlayResult): { readonly kind: "ok" } | { readonly kind: "refused"; readonly reason: string } {
  return result.kind === "ok" ? result : { kind: "refused", reason: result.reason };
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
