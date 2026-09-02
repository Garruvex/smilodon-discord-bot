import type { Logger } from "pino";

import { AccessPolicyService } from "../application/access/access-policy-service.js";
import { CommandDispatcher } from "../application/commands/command-dispatcher.js";
import { CommandRegistry } from "../application/commands/command-registry.js";
import type { ApplicationConfiguration } from "../config/configuration.js";
import { PlaybackService } from "../application/music/playback-service.js";
import type { MusicPlayerGateway } from "../application/music/music-player-gateway.js";
import type { GuildConfigurationProvider } from "../config/guild-configuration-provider.js";
import { PingCommand } from "../infrastructure/discord/commands/common/ping-command.js";
import { UserInfoCommand } from "../infrastructure/discord/commands/common/userinfo-command.js";
import { QuoteCommand } from "../infrastructure/discord/commands/common/quote-command.js";
import { QuoteContextCommand } from "../infrastructure/discord/commands/common/quote-context-command.js";
import { HelpCommand } from "../infrastructure/discord/commands/common/help-command.js";
import { BirthdayCommand } from "../infrastructure/discord/commands/common/birthday-command.js";
import type { BirthdayStore } from "../application/birthdays/birthday-store.js";
import { RemindCommand } from "../infrastructure/discord/commands/common/remind-command.js";
import { ReactionRolesCommand } from "../infrastructure/discord/commands/common/reaction-roles-command.js";
import { RoleMenuComponentHandler } from "../infrastructure/discord/components/role-menu-component-handler.js";
import { RoleMenuService } from "../application/roles/role-menu-service.js";
import type { RoleMenuStore } from "../application/roles/role-menu-store.js";
import type { ReminderStore } from "../application/reminders/reminder-store.js";
import { ReminderScheduler } from "../application/reminders/reminder-scheduler.js";
import { OwoifyCommand } from "../infrastructure/discord/commands/common/owoify-command.js";
import { WolfyCommand } from "../infrastructure/discord/commands/common/wolfy-command.js";
import { QaCommand } from "../infrastructure/discord/commands/common/qa-command.js";
import { CleanCommand } from "../infrastructure/discord/commands/common/clean-command.js";
import { DiceCommand } from "../infrastructure/discord/commands/common/dice-command.js";
import { EightBallCommand } from "../infrastructure/discord/commands/common/eightball-command.js";
import { FiltersCommand } from "../infrastructure/discord/commands/music/filters-command.js";
import { SaveCommand } from "../infrastructure/discord/commands/music/save-command.js";
import { SeekCommand } from "../infrastructure/discord/commands/music/seek-command.js";
import { ReplayCommand } from "../infrastructure/discord/commands/music/replay-command.js";
import { MoveCommand } from "../infrastructure/discord/commands/music/move-command.js";
import { PlayNextCommand } from "../infrastructure/discord/commands/music/playnext-command.js";
import { RandomAnimalFactCommand } from "../infrastructure/discord/commands/image/random-animal-fact-command.js";
import { FurryReactionCommand } from "../infrastructure/discord/commands/image/furry-reaction-command.js";
import { BooruSearchCommand } from "../infrastructure/discord/commands/image/booru-search-command.js";
import { FursuitFurtrackCommand } from "../infrastructure/discord/commands/image/fursuit-furtrack-command.js";
import { DiagnosticCommand } from "../infrastructure/discord/commands/diagnostics/diagnostic-command.js";
import { PauseCommand } from "../infrastructure/discord/commands/music/pause-command.js";
import { PlayCommand } from "../infrastructure/discord/commands/music/play-command.js";
import { ResumeCommand } from "../infrastructure/discord/commands/music/resume-command.js";
import { StopCommand } from "../infrastructure/discord/commands/music/stop-command.js";
import { SkipCommand } from "../infrastructure/discord/commands/music/skip-command.js";
import { SkipToCommand } from "../infrastructure/discord/commands/music/skipto-command.js";
import { QueueCommand } from "../infrastructure/discord/commands/music/queue-command.js";
import { LoopCommand } from "../infrastructure/discord/commands/music/loop-command.js";
import { VolumeCommand } from "../infrastructure/discord/commands/music/volume-command.js";
import { AutoplayCommand } from "../infrastructure/discord/commands/music/autoplay-command.js";
import { TwentyFourSevenCommand } from "../infrastructure/discord/commands/music/twenty-four-seven-command.js";
import { ShuffleCommand } from "../infrastructure/discord/commands/music/shuffle-command.js";
import { PreviousCommand } from "../infrastructure/discord/commands/music/previous-command.js";
import type { GuildSetupService } from "../application/setup/guild-setup-service.js";
import { SetupCommand } from "../infrastructure/discord/commands/setup/setup-command.js";
import { SettingsCommand } from "../infrastructure/discord/commands/setup/settings-command.js";
import { VoteCommand } from "../infrastructure/discord/commands/common/vote-command.js";
import { MemoryCommand } from "../infrastructure/discord/commands/common/memory-command.js";
import { CustomizeCommand } from "../infrastructure/discord/commands/common/customize-command.js";
import type { UserCustomizationStore } from "../application/chat/user-customization-store.js";
import { PollService } from "../application/polls/poll-service.js";
import { BehaviorRegistry } from "../application/behaviors/behavior-registry.js";
import { BehaviorDispatcher } from "../application/behaviors/behavior-dispatcher.js";
import { MentionChatBehavior } from "../infrastructure/discord/behaviors/mention-chat-behavior.js";
import { AmbientChatBehavior } from "../infrastructure/discord/behaviors/ambient-chat-behavior.js";
import { LinkFixBehavior } from "../infrastructure/discord/behaviors/link-fix-behavior.js";
import { BilibiliEmbedService } from "../infrastructure/links/bilibili-embed-service.js";
import type { ChatProvider } from "../application/chat/chat-provider.js";
import { OpenAiCompatibleChatProvider } from "../infrastructure/chat/openai-compatible-chat-provider.js";
import { OpenAiResponsesChatProvider } from "../infrastructure/chat/openai-responses-chat-provider.js";
import { GeminiChatProvider } from "../infrastructure/chat/gemini-chat-provider.js";
import type { Client } from "discord.js";
import { GuildAssetStore } from "../application/assets/guild-asset-store.js";
import { ComponentRegistry } from "../application/components/component-registry.js";
import { ComponentDispatcher } from "../application/components/component-dispatcher.js";
import { PollComponentHandler } from "../infrastructure/discord/components/poll-component-handler.js";
import type { ChatStateStore } from "../application/chat/chat-state-store.js";
import { ChatConversationService } from "../application/chat/chat-conversation-service.js";
import { ChatToolRegistry } from "../application/chat/tools/chat-tool-registry.js";
import { DiceRollTool } from "../application/chat/tools/dice-tool.js";
import { EightBallTool } from "../application/chat/tools/eightball-tool.js";
import { BooruSearchTool } from "../application/chat/tools/booru-search-tool.js";
import { MemoryLookupTool } from "../application/chat/tools/memory-lookup-tool.js";
import { BirthdayLookupTool } from "../application/chat/tools/birthday-lookup-tool.js";
import { ReadLinkTool } from "../application/chat/tools/read-link-tool.js";
import { RelevantExampleExchangeSelector } from "../application/chat/example-exchange-selector.js";
import { RelevantPersonaLoreSelector } from "../application/chat/persona-lore-selector.js";
import { PersonaBundleCompiler } from "../application/chat/persona-bundle-compiler.js";
import { PersonaDriftStore } from "../application/chat/persona-drift-store.js";
import type { MemoryRepository } from "../application/memory/memory.js";
import { DefaultMemoryEngine } from "../application/memory/memory-engine.js";
import type { MemoryEngine } from "../application/memory/memory.js";
import type { ChannelSummaryCheckpointStore } from "../application/context/channel-summary-checkpoint-store.js";
import { ChannelSummaryScheduler } from "../application/context/channel-summary-scheduler.js";
import { DiscordChannelHistoryReader } from "../infrastructure/discord/context/discord-channel-history-reader.js";
import { FilePersonaSource } from "../infrastructure/chat/file-persona-source.js";
import { OpenAiEmbeddingsClient } from "../infrastructure/chat/openai-embeddings-client.js";
import { GeminiEmbeddingsClient } from "../infrastructure/chat/gemini-embeddings-client.js";
import { embeddingDimensions } from "../infrastructure/database/schema.js";
import { ApplicationEmojiCatalog } from "../infrastructure/discord/application-emoji-catalog.js";
import type { AuditLogService } from "../application/audit/audit-log-service.js";
import { MemberProfileService } from "../application/members/member-profile-service.js";
import type { EmbeddingsClient } from "../application/chat/embeddings-client.js";

// Shape common to both configuration.chat and configuration.utilityChat —
// summaryModels is optional here since only `chat` carries it (utilityChat
// IS the summary/utility model already, see configuration.ts).
type ProviderConfig =
  | {
      provider: "openai-responses";
      apiKey: string;
      baseUrl: string;
      models: readonly string[];
      reasoningEffort: "minimal" | "low" | "medium" | "high";
      verbosity: "low" | "medium" | "high";
      maxOutputTokens: number;
      summaryModels?: readonly string[];
      summaryMaxOutputTokens?: number;
      summaryReasoningEffort?: "minimal" | "low" | "medium" | "high";
    }
  | {
      provider: "openai-compatible";
      apiKey: string;
      baseUrl: string;
      models: readonly string[];
      maxOutputTokens: number;
      summaryModels?: readonly string[];
      summaryMaxOutputTokens?: number;
    }
  | {
      provider: "gemini";
      apiKey: string;
      models: readonly string[];
      maxOutputTokens: number;
      thinkingBudget: number | null;
      summaryModels?: readonly string[];
      summaryMaxOutputTokens?: number;
    };

// Shared by both the main chatbot provider (configuration.chat) and the
// optional fully-independent utility provider (configuration.utilityChat) —
// same 3-way branch, just parameterized on which config block it's building
// from. summaryModels defaults to the provider's own `models` when omitted
// (utilityChat never sets it — it IS the summary/utility model already).
function createChatProviderFromConfig(config: ProviderConfig, logger: Logger): ChatProvider {
  const summaryModels = config.summaryModels ?? config.models;
  if (config.provider === "openai-responses") {
    return new OpenAiResponsesChatProvider(
      config.baseUrl,
      config.apiKey,
      config.models,
      {
        reasoningEffort: config.reasoningEffort,
        verbosity: config.verbosity,
        maxOutputTokens: config.maxOutputTokens,
        summaryModels,
        ...(config.summaryMaxOutputTokens !== undefined
          ? { summaryMaxOutputTokens: config.summaryMaxOutputTokens }
          : {}),
        ...(config.summaryReasoningEffort !== undefined
          ? { summaryReasoningEffort: config.summaryReasoningEffort }
          : {}),
      },
    );
  }
  if (config.provider === "gemini") {
    return new GeminiChatProvider(
      config.apiKey,
      config.models,
      {
        maxOutputTokens: config.maxOutputTokens,
        thinkingBudget: config.thinkingBudget,
        summaryModels,
        ...(config.summaryMaxOutputTokens !== undefined
          ? { summaryMaxOutputTokens: config.summaryMaxOutputTokens }
          : {}),
      },
    );
  }
  return new OpenAiCompatibleChatProvider(
    config.baseUrl,
    config.apiKey,
    config.models,
    summaryModels,
    logger.child({ component: "chat-provider" }),
    config.summaryMaxOutputTokens,
  );
}

export interface ApplicationDependencies {
  commandRegistry: CommandRegistry;
  commandDispatcher: CommandDispatcher;
  componentDispatcher: ComponentDispatcher;
  musicPlayerGateway: MusicPlayerGateway;
  guildConfigurationProvider: GuildConfigurationProvider;
  playbackService: PlaybackService;
  pollService: PollService;
  behaviorDispatcher: BehaviorDispatcher;
  settingsCommand: SettingsCommand;
  // Null when no chat provider is configured — there's nothing to
  // summarize channel messages with, same condition chatConversationService
  // already checks.
  channelSummaryScheduler: ChannelSummaryScheduler | null;
  reminderScheduler: ReminderScheduler;
  applicationEmojiCatalog: ApplicationEmojiCatalog;
  memoryEngine: MemoryEngine;
}

// Everything registerCommands() builds that createDependencies() (or any
// other caller that only wants live command/component instances — see
// scripts/deploy-commands.ts) needs, either as its own return value or to
// keep building the surrounding chat/behavior/scheduler runtime on top of.
export interface CommandRegistrationResult {
  commandRegistry: CommandRegistry;
  componentRegistry: ComponentRegistry;
  accessPolicyService: AccessPolicyService;
  playbackService: PlaybackService;
  pollService: PollService;
  settingsCommand: SettingsCommand;
  applicationEmojiCatalog: ApplicationEmojiCatalog;
  memoryEngine: MemoryEngine;
  guildAssetStore: GuildAssetStore;
  personaDriftStore: PersonaDriftStore;
  // Null unless an embeddings provider is configured at all.
  embeddingsClient: EmbeddingsClient | null;
  // Both null when no chat provider is configured at all.
  chatProvider: ChatProvider | null;
  utilityProvider: ChatProvider | null;
}

// Constructs the CommandRegistry with every command (and the
// ComponentRegistry with every component) registered, plus the handful of
// supporting services their constructors need — nothing dispatch-, behavior-,
// or scheduler-related. This is the one piece scripts/deploy-commands.ts
// actually needs (just commandRegistry.getAll() for command metadata) — it
// used to go through the full createDependencies() below, constructing a
// chat conversation service, behavior registry, and channel-summary
// scheduler it would then immediately discard.
export function registerCommands(
  configuration: ApplicationConfiguration,
  logger: Logger,
  musicPlayerGateway: MusicPlayerGateway,
  guildConfigurationProvider: GuildConfigurationProvider,
  guildSetupService: GuildSetupService,
  discordClient: Client,
  chatStateStore: ChatStateStore,
  userCustomizationStore: UserCustomizationStore,
  auditLogService: AuditLogService,
  birthdayStore: BirthdayStore,
  memoryRepository: MemoryRepository,
  channelSummaryCheckpointStore: ChannelSummaryCheckpointStore,
  reminderStore: ReminderStore,
  roleMenuStore: RoleMenuStore,
): CommandRegistrationResult {
  const commandRegistry = new CommandRegistry();
  const pollService = new PollService();
  const componentRegistry = new ComponentRegistry();
  componentRegistry.register(new PollComponentHandler(pollService));
  const roleMenuService = new RoleMenuService(roleMenuStore, logger.child({ component: "role-menu" }));
  componentRegistry.register(new RoleMenuComponentHandler(roleMenuService));
  commandRegistry.register(new PingCommand());
  commandRegistry.register(new UserInfoCommand(guildConfigurationProvider));
  commandRegistry.register(new QuoteCommand());
  commandRegistry.register(new QuoteContextCommand());
  commandRegistry.register(new DiagnosticCommand());
  commandRegistry.register(new SetupCommand(guildSetupService));
  commandRegistry.register(new VoteCommand(pollService));
  const embeddingsClient = configuration.embeddings
    ? configuration.embeddings.provider === "gemini"
      ? new GeminiEmbeddingsClient(configuration.embeddings.apiKey, configuration.embeddings.model, embeddingDimensions)
      : new OpenAiEmbeddingsClient(
          configuration.embeddings.baseUrl,
          configuration.embeddings.apiKey,
          configuration.embeddings.model,
        )
    : null;
  commandRegistry.register(new BirthdayCommand(birthdayStore, guildConfigurationProvider));
  commandRegistry.register(new RemindCommand(reminderStore));
  commandRegistry.register(new ReactionRolesCommand(roleMenuService));
  commandRegistry.register(new OwoifyCommand());
  commandRegistry.register(new WolfyCommand());
  commandRegistry.register(new QaCommand());
  commandRegistry.register(new CleanCommand());
  commandRegistry.register(new DiceCommand());
  commandRegistry.register(new EightBallCommand());
  for (const [species, emoji, footer] of [
    ["bird", "🦉", "BORB!"],
    ["cat", "🐈", "KITTY!"],
    ["dog", "🐕", "DOG"],
    ["fox", "🦊", "FOXY!"],
    ["raccoon", "🦝", "RACCOON!"],
  ] as const) {
    commandRegistry.register(new RandomAnimalFactCommand(species, emoji, footer));
  }
  for (const [key, description, title, reactionText, footer] of [
    ["boop", "Gets a random boop image.", "🐽", "boop!", "👃👃👃"],
    ["hold", "Gets a random hold image.", "✋🦝🤚", "hold me tight!", "🦦"],
    ["howl", "Gets a random howl image.", "🕪🐕", "Rawr!", "🐾"],
    ["hug", "Gets a random hug image.", "🤗", "HUG!", "🤔"],
    ["kiss", "Gets a random kiss image.", "😘", "kisssssie!", "😚"],
    ["lick", "Gets a random lick image.", "💰🍆", "slurp!", "🍌🍌🍌"],
  ] as const) {
    commandRegistry.register(new FurryReactionCommand(key, description, title, reactionText, footer, false));
  }
  commandRegistry.register(new BooruSearchCommand("e926", "#66FF33", false));
  commandRegistry.register(new FursuitFurtrackCommand());
  commandRegistry.register(new FurryReactionCommand("bulge", "Gets a random bulge image. NSFW.", "✋🦝🤚", "OwO whats this? *notices bulge*", "🦦", true));
  commandRegistry.register(new FurryReactionCommand("butts", "Gets a random butt image. NSFW.", "🍑", "butttttttttt", "🍑🍑🍑", true));
  commandRegistry.register(new BooruSearchCommand("e621", "#09CDE2", true));
  const playbackService = new PlaybackService(musicPlayerGateway);
  commandRegistry.register(new PlayCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new PlayNextCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new PauseCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new ResumeCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new StopCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new SkipCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new SkipToCommand(playbackService));
  commandRegistry.register(new PreviousCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new ShuffleCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new QueueCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new LoopCommand(playbackService));
  commandRegistry.register(new VolumeCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new AutoplayCommand(playbackService));
  commandRegistry.register(new TwentyFourSevenCommand(playbackService));
  commandRegistry.register(new FiltersCommand(playbackService));
  commandRegistry.register(new SaveCommand(playbackService));
  commandRegistry.register(new SeekCommand(playbackService));
  commandRegistry.register(new ReplayCommand(playbackService));
  commandRegistry.register(new MoveCommand(playbackService));

  const accessPolicyService = new AccessPolicyService(
    configuration,
    guildConfigurationProvider,
  );
  commandRegistry.register(new HelpCommand(commandRegistry, accessPolicyService, guildConfigurationProvider));

  const chatProvider = configuration.chat ? createChatProviderFromConfig(configuration.chat, logger) : null;
  // Fully independent provider for the two standalone structured-output
  // calls (analyzeUserCustomization, summarizeDroppedExchanges) when
  // configuration.utilityChat is set (own credentials/model, can be a
  // different provider type entirely). Falls back to `chatProvider` itself
  // when unset — which already does its own same-credentials summary-model
  // routing internally (configuration.chat.summaryModels) — so this adds a
  // layer on top rather than replacing it, and requires no config change
  // for anyone not using UTILITY_*.
  const utilityProvider = configuration.utilityChat
    ? createChatProviderFromConfig(configuration.utilityChat, logger)
    : chatProvider;
  // Conflict-at-write classification (see MemoryConflictClassifier on
  // ChatProvider) prefers the cheaper utility model, same as every other
  // standalone structured-output call — DefaultMemoryEngine treats a
  // provider that doesn't implement the capability the same as no provider
  // at all (falls back to the similarity threshold alone).
  const memoryEngine = new DefaultMemoryEngine(
    memoryRepository, embeddingsClient, logger.child({ component: "memory-engine" }), configuration.memory,
    utilityProvider,
  );
  const memberProfileService = new MemberProfileService(memoryEngine, birthdayStore, userCustomizationStore);
  commandRegistry.register(new MemoryCommand(chatStateStore, memberProfileService, memoryEngine));
  // Personality-bundle compilation is a standalone structured-output call
  // (same shape as summarizeDroppedExchanges) — prefers the cheaper
  // utility model when one is configured, same as ChatConversationService's
  // own consolidation call below.
  const personaBundleCompiler = utilityProvider
    ? new PersonaBundleCompiler(utilityProvider, embeddingsClient, logger.child({ component: "persona-bundle-compiler" }))
    : null;
  const guildAssetStore = new GuildAssetStore(
    configuration.runtimeDataDirectory,
    personaBundleCompiler,
    embeddingsClient,
    logger.child({ component: "guild-assets" }),
  );
  const personaDriftStore = new PersonaDriftStore(
    configuration.runtimeDataDirectory,
    logger.child({ component: "persona-drift" }),
  );
  const applicationEmojiCatalog = new ApplicationEmojiCatalog(
    discordClient,
    logger.child({ component: "emoji-catalog" }),
  );
  const settingsCommand = new SettingsCommand(
    guildConfigurationProvider,
    guildAssetStore,
    applicationEmojiCatalog,
    auditLogService,
    personaDriftStore,
    channelSummaryCheckpointStore,
    utilityProvider?.summarizeChannelMessages !== undefined,
  );
  commandRegistry.register(settingsCommand);
  commandRegistry.register(new CustomizeCommand(userCustomizationStore, utilityProvider));

  return {
    commandRegistry,
    componentRegistry,
    accessPolicyService,
    playbackService,
    pollService,
    settingsCommand,
    applicationEmojiCatalog,
    memoryEngine,
    guildAssetStore,
    personaDriftStore,
    embeddingsClient,
    chatProvider,
    utilityProvider,
  };
}

export function createDependencies(
  configuration: ApplicationConfiguration,
  logger: Logger,
  musicPlayerGateway: MusicPlayerGateway,
  guildConfigurationProvider: GuildConfigurationProvider,
  guildSetupService: GuildSetupService,
  discordClient: Client,
  chatStateStore: ChatStateStore,
  userCustomizationStore: UserCustomizationStore,
  auditLogService: AuditLogService,
  birthdayStore: BirthdayStore,
  memoryRepository: MemoryRepository,
  channelSummaryCheckpointStore: ChannelSummaryCheckpointStore,
  reminderStore: ReminderStore,
  roleMenuStore: RoleMenuStore,
): ApplicationDependencies {
  const {
    commandRegistry,
    componentRegistry,
    accessPolicyService,
    playbackService,
    pollService,
    settingsCommand,
    applicationEmojiCatalog,
    memoryEngine,
    personaDriftStore,
    embeddingsClient,
    chatProvider,
    utilityProvider,
  } = registerCommands(
    configuration, logger, musicPlayerGateway, guildConfigurationProvider, guildSetupService,
    discordClient, chatStateStore, userCustomizationStore, auditLogService, birthdayStore,
    memoryRepository, channelSummaryCheckpointStore, reminderStore, roleMenuStore,
  );

  const reminderScheduler = new ReminderScheduler(
    discordClient, reminderStore, logger.child({ component: "reminders" }),
  );

  const commandDispatcher = new CommandDispatcher(
    commandRegistry,
    accessPolicyService,
    logger.child({ component: "commands" }),
  );
  const componentDispatcher = new ComponentDispatcher(
    componentRegistry,
    accessPolicyService,
    logger.child({ component: "components" }),
  );
  const behaviorRegistry = new BehaviorRegistry();

  // Prefers the cheaper utility model when configured, same preference as
  // ChatConversationService's own consolidation call. Null when no chat
  // provider is configured, or the configured one doesn't implement
  // summarizeChannelMessages — narrowing to ChannelMessageSummarizer here
  // (rather than passing the full ChatProvider) makes that a wiring-time
  // check instead of the scheduler probing an optional method at runtime.
  const channelSummaryScheduler = utilityProvider?.summarizeChannelMessages
    ? new ChannelSummaryScheduler(
        new DiscordChannelHistoryReader(discordClient), guildConfigurationProvider, memoryEngine, channelSummaryCheckpointStore,
        { summarizeChannelMessages: utilityProvider.summarizeChannelMessages.bind(utilityProvider) },
        logger.child({ component: "channel-summary-scheduler" }),
      )
    : null;
  // Derived from CommandRegistry rather than hand-listed: any BotCommand
  // that sets `toolBinding` (see command.ts) is automatically offered to the
  // model, so a command's LLM exposure has one source of truth — the
  // command file itself — instead of a second array to keep in sync here.
  const commandToolBindings = commandRegistry.getAll().flatMap((command) =>
    command.toolBinding ? [command.toolBinding] : []);
  const chatToolRegistry = new ChatToolRegistry([
    new DiceRollTool(),
    new EightBallTool(),
    new BooruSearchTool(),
    new MemoryLookupTool(memoryEngine),
    new BirthdayLookupTool(birthdayStore),
    new ReadLinkTool(),
    ...commandToolBindings,
  ]);
  settingsCommand.bindChatToolRegistry(chatToolRegistry);
  const chatConversationService = chatProvider
    ? new ChatConversationService(
        chatProvider,
        chatStateStore,
        memoryEngine,
        undefined,
        new RelevantExampleExchangeSelector(embeddingsClient, logger.child({ component: "example-exchange-selector" })),
        new RelevantPersonaLoreSelector(embeddingsClient, logger.child({ component: "persona-lore-selector" })),
        userCustomizationStore,
        birthdayStore,
        chatToolRegistry,
        logger.child({ component: "chat-conversation" }),
        utilityProvider,
        personaDriftStore,
      )
    : null;
  const personaSource = new FilePersonaSource(
    configuration.runtimeDataDirectory,
    logger.child({ component: "persona-source" }),
    personaDriftStore,
  );
  behaviorRegistry.register(new MentionChatBehavior(
    () => discordClient.user?.id ?? null,
    configuration,
    guildConfigurationProvider,
    chatConversationService,
    personaSource,
    logger.child({ component: "chat" }),
  ));
  behaviorRegistry.register(new AmbientChatBehavior(
    () => discordClient.user?.id ?? null,
    configuration,
    guildConfigurationProvider,
    chatConversationService,
    personaSource,
    logger.child({ component: "ambient-chat" }),
  ));
  behaviorRegistry.register(new LinkFixBehavior(
    guildConfigurationProvider,
    new BilibiliEmbedService(logger.child({ component: "bilibili-embed" })),
    logger.child({ component: "link-fix" }),
  ));

  return {
    commandRegistry,
    commandDispatcher,
    componentDispatcher,
    musicPlayerGateway,
    guildConfigurationProvider,
    playbackService,
    pollService,
    behaviorDispatcher: new BehaviorDispatcher(behaviorRegistry),
    settingsCommand,
    channelSummaryScheduler,
    reminderScheduler,
    applicationEmojiCatalog,
    memoryEngine,
  };
}
