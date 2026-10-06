import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ActivityTableService } from "../infrastructure/activity/activity-table-service.js";
import { createActivityActionHandler } from "../infrastructure/activity/activity-action-handler.js";
import type { ActivityCampaignApi, ActivityCharacterDetail } from "../infrastructure/activity/activity-server.js";
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
import { buildClasses, classTemplates, selectableBuildRaces, suggestedAbilities } from "../domain/campaign/character/character-build.js";
import { skills } from "../domain/campaign/rules/skills.js";
import { CampaignLobbyService, type ActivityCampaignListingItem, type ServiceResult } from "../application/campaign/campaign-lobby-service.js";
import { CampaignPlayController } from "../application/campaign/campaign-play-controller.js";
import { buildActivityLobbyView, buildActivityTableView, canSeeActivityCampaign } from "../application/campaign/activity-view.js";
import { libraryHeroRef } from "../application/campaign/library/library-types.js";
import { CampaignRuntime } from "../application/campaign/campaign-runtime.js";
import { LlmCampaignChronicler } from "../application/campaign/dm/llm-chronicler.js";
import { LlmCampaignNarrator, LlmCampaignPlanner } from "../application/campaign/dm/llm-dm.js";
import { LlmNarrationAuditor } from "../application/campaign/dm/llm-narration-auditor.js";
import { LlmSceneNoteJudge } from "../application/campaign/dm/llm-scene-note-judge.js";
import type { CampaignNarrator, CampaignPlanner } from "../application/campaign/ports/dm-ports.js";
import type { CampaignTransaction, CampaignUnitOfWork } from "../application/campaign/ports/campaign-store.js";
import type { CampaignRecord } from "../application/campaign/ports/campaign-record.js";
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
  readonly activity: ActivityCampaignApi;
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
  // Activity writes use the same command bus and engine checks. The API
  // refreshes cards once per accepted action, including quiet state changes.
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
    dm: new DmJobWorker({ unitOfWork, bus, planner, narrator, ...(model === null ? {} : { chronicler: new LlmCampaignChronicler({ client: model, cacheKey }), noteJudge: new LlmSceneNoteJudge({ client: model, cacheKey }), ...(configuration.campaignNarrationAudit === false ? {} : { auditor: new LlmNarrationAuditor({ client: model, cacheKey }) }) }), adventures, glossaries, rulesets, logger }),
    delivery: new DeliveryWorker(unitOfWork, presenter, {
      clock,
      onAbandoned: async (key, item): Promise<void> => {
        await issues.raise(key, "deliveryFailed", item.request.kind === "deliver" ? item.request.delivery.kind : item.request.kind);
      },
    }),
    queuedJoins: { runOnce: (): ReturnType<CampaignLobbyService["processQueuedJoins"]> => lobby.processQueuedJoins() },
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
    unitOfWork, lobby, play: activityPlay, creator, adventures, now: (): number => clock.now(), refresh: (key): void => cards.refresh(key),
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
  const catalog = new AdventureCatalog({ unitOfWork, clock, content, library: adventures, storyContract: "enforce" });
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
  const activityActions = createActivityActionHandler({ lobby, play: activityPlay, library, onAccepted: (key): void => cards.refresh(key) });
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
      getCharacter: async (userId, characterId): Promise<ActivityCharacterDetail | null> => {
        const entry = await library.entry(userId, characterId);
        if (entry === undefined) return null;
        return { id: entry.character.id, name: entry.character.name, versions: [...entry.snapshots].sort((a, b) => a.revision - b.revision).map((snapshot) => ({ id: snapshot.id, revision: snapshot.revision, branch: snapshot.branch, source: snapshot.source.kind, createdAt: snapshot.createdAt, build: snapshot.build, gear: snapshot.gear, progression: snapshot.progression ?? null })) };
      },
      characterPortrait: async (userId, characterId) => (await portraits.current(userId, characterId)) ?? null,
      portraits,
      createCharacter: async (userId, build): ReturnType<ActivityCampaignApi["createCharacter"]> => {
        const result = await library.create(userId, build);
        return result.kind === "ok" ? { kind: "ok" as const, characterId: result.character.id } : result;
      },
      editCharacter: async (userId, characterId, build): ReturnType<ActivityCampaignApi["editCharacter"]> => {
        const result = await library.edit(userId, characterId, build);
        return result.kind === "ok" ? { kind: "ok" as const } : result;
      },
      deleteCharacter: (userId, characterId) => library.remove(userId, characterId),
      listGames: (guildId, userId): Promise<readonly ActivityCampaignListingItem[]> => lobby.activityGames(guildId, userId),
      gameForChannel: (guildId, userId, channelId): Promise<ActivityCampaignListingItem | null> => lobby.activityGameForChannel(guildId, userId, channelId),
      joinLobby: (key, userId): Promise<ServiceResult<CampaignRecord>> => lobby.joinFromActivity(key, userId),
      requestJoin: (key, userId): Promise<ServiceResult<CampaignRecord>> => lobby.requestOngoingJoin(key, userId),
      withdrawJoin: (key, userId): Promise<ServiceResult<CampaignRecord>> => lobby.withdrawOngoingJoin(key, userId),
      snapshot: async (key, userId, since): ReturnType<ActivityCampaignApi["snapshot"]> => {
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
      image: async (key, userId, kind, id): ReturnType<ActivityCampaignApi["image"]> => {
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
      act: activityActions,
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
