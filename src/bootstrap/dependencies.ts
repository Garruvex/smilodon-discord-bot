import { GuardedEvaluationContext } from "../application/context/guarded-evaluation-context.js";
import { guardModelTransport } from "../application/context/guarded-model-transport.js";
import { guardEmbeddingTransport } from "../application/context/guarded-embedding-transport.js";
import { interviewProbes } from "../application/chat/character-evaluation.js";
import { CommandModule } from "../application/commands/command.js";
import { settingsAccessPolicy } from "../infrastructure/discord/settings/engine/settings-engine.js";
import { defaultLanguage } from "../application/i18n/language.js";
import { instrumentModel, modelGenerationHealth } from "../application/diagnostics/model-diagnostics.js";
import { diagnosticPipelineStatus } from "../application/diagnostics/chat-diagnostics.js";
import { catalogIssues } from "../application/i18n/texts.js";
import type { Logger } from "pino";
import type { MessageOriginStore } from "../application/chat/message-origin-store.js";
import type { ConversationEpisodeStore } from "../application/chat/conversation-episode-store.js";
import { SocialChatEligibility } from "../infrastructure/discord/behaviors/social-chat-eligibility.js";
import { ChatTurnSupport } from "../infrastructure/discord/behaviors/chat-turn-support.js";
import { guardedToolResourcePort } from "../application/chat/guarded-tool-gateway.js";
import { ReviewedMusicTool } from "../infrastructure/discord/commands/music/reviewed-music-tool.js";
import { conversationConfiguration } from "../application/context/conversation-configuration.js";
import { withSessionMessageOrigins } from "../application/chat/session-message-origins.js";
import { isGuardedContext } from "../application/chat/guarded-conversation-context.js";
import { resolveChannelMemoryMode } from "../application/memory/memory-channel-policy.js";
import { ConversationObservationBehavior } from "../infrastructure/discord/behaviors/conversation-observation-behavior.js";
import { ProactiveChatBehavior } from "../infrastructure/discord/behaviors/proactive-chat-behavior.js";

import { AccessPolicyService } from "../application/access/access-policy-service.js";
import { createCampaignModule, type CampaignModule } from "./campaign-module.js";
import { CommandDispatcher } from "../application/commands/command-dispatcher.js";
import { CommandRegistry } from "../application/commands/command-registry.js";
import type { ApplicationConfiguration } from "../config/configuration.js";
import { PlaybackService } from "../application/music/playback-service.js";
import type { MusicPlayerGateway } from "../application/music/music-player-gateway.js";
import type { GuildConfigurationProvider } from "../config/guild-configuration-provider.js";
import { PingCommand } from "../infrastructure/discord/commands/common/ping-command.js";
import { UserInfoCommand } from "../infrastructure/discord/commands/common/userinfo-command.js";
import { BoostsCommand } from "../infrastructure/discord/commands/common/boosts-command.js";
import type { BoostHistoryStore } from "../application/members/boost-history-store.js";
import { QuoteCommand } from "../infrastructure/discord/commands/common/quote-command.js";
import { QuoteContextCommand } from "../infrastructure/discord/commands/common/quote-context-command.js";
import { HelpCommand } from "../infrastructure/discord/commands/common/help-command.js";
import { BirthdayCommand } from "../infrastructure/discord/commands/common/birthday-command.js";
import type { BirthdayStore } from "../application/birthdays/birthday-store.js";
import { RemindCommand } from "../infrastructure/discord/commands/common/remind-command.js";
import { ReactionRolesCommand } from "../infrastructure/discord/commands/common/reaction-roles-command.js";
import { RoleMenuComponentHandler } from "../infrastructure/discord/components/role-menu-component-handler.js";
import { QueuePageComponentHandler } from "../infrastructure/discord/components/queue-page-component-handler.js";
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
import { ExplainMessageCommand } from "../infrastructure/discord/commands/diagnostics/explain-message-command.js";
import { diagnosticStore } from "../application/diagnostics/chat-diagnostics.js";
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
import { StatusCommand } from "../infrastructure/discord/commands/setup/status-command.js";
import { AdminPanelHealth } from "../application/settings/admin-panel-health.js";
import { SetupGuide } from "../infrastructure/discord/settings/setup/setup-guide.js";
import { SetupGuideComponentHandler } from "../infrastructure/discord/components/setup-guide-component-handler.js";
import { SettingsUpdateService } from "../application/settings/settings-update-service.js";
import { SettingsEngine } from "../infrastructure/discord/settings/engine/settings-engine.js";
import { settingsRegistry } from "../infrastructure/discord/settings/groups/index.js";
import { SettingsCommand } from "../infrastructure/discord/settings/slash/settings-command.js";
import { VoteCommand } from "../infrastructure/discord/commands/common/vote-command.js";
import { MemoryCommand } from "../infrastructure/discord/commands/common/memory-command.js";
import { MemoryEvalCommand } from "../infrastructure/discord/commands/diagnostics/memory-eval-command.js";
import { CustomizeCommand } from "../infrastructure/discord/commands/common/customize-command.js";
import type { UserCustomizationStore } from "../application/chat/user-customization-store.js";
import { PollService } from "../application/polls/poll-service.js";
import { BehaviorRegistry } from "../application/behaviors/behavior-registry.js";
import { BehaviorDispatcher } from "../application/behaviors/behavior-dispatcher.js";
import { MentionChatBehavior } from "../infrastructure/discord/behaviors/mention-chat-behavior.js";
import { AmbientChatBehavior } from "../infrastructure/discord/behaviors/ambient-chat-behavior.js";
import { ReactionArmBehavior } from "../infrastructure/discord/behaviors/reaction-arm-behavior.js";
import { ReactionReplyScheduler } from "../infrastructure/discord/behaviors/reaction-reply-scheduler.js";
import { ChannelEditScheduler } from "../application/concurrency/channel-edit-scheduler.js";
import type { MessageReactionWatchStore } from "../application/chat/message-reaction-watch.js";
import { LinkFixBehavior } from "../infrastructure/discord/behaviors/link-fix-behavior.js";
import { SpamGuardBehavior } from "../infrastructure/discord/behaviors/spam-guard-behavior.js";
import { TrapChannelBehavior } from "../infrastructure/discord/behaviors/trap-channel-behavior.js";
import { LinkGuardService } from "../infrastructure/discord/security/link-guard-service.js";
import { RaidService } from "../infrastructure/discord/security/raid-service.js";
import { SpamService } from "../infrastructure/discord/security/spam-service.js";
import { TrapService } from "../infrastructure/discord/security/trap-service.js";
import type { ChatProvider } from "../application/chat/chat-provider.js";
import { OpenAiCompatibleChatProvider } from "../infrastructure/chat/openai-compatible-chat-provider.js";
import { OpenAiResponsesChatProvider } from "../infrastructure/chat/openai-responses-chat-provider.js";
import { GeminiChatProvider } from "../infrastructure/chat/gemini-chat-provider.js";
import type { Client, Message } from "discord.js";
import { GuildAssetStore } from "../application/assets/guild-asset-store.js";
import { ComponentRegistry } from "../application/components/component-registry.js";
import { ComponentDispatcher } from "../application/components/component-dispatcher.js";
import { PollComponentHandler } from "../infrastructure/discord/components/poll-component-handler.js";
import type { ChatStateStore } from "../application/chat/chat-state-store.js";
import { ChatConversationService } from "../application/chat/chat-conversation-service.js";
import { CharacterRuntime } from "../application/chat/character-runtime.js";
import { CharacterEvaluationStore } from "../application/chat/character-evaluation.js";
import { CharacterEvalCommand, FeltLikeBotCommand } from "../infrastructure/discord/commands/diagnostics/character-eval-command.js";
import { resolveParticipation } from "../application/chat/participation-policy.js";
import { SocialOutputSuppressed } from "../application/chat/message-origin-store.js";
import { HttpDecisionProvider } from "../infrastructure/chat/http-decision-provider.js";
import { contextualDecisionProviders } from "../application/chat/contextual-decision-providers.js";
import { characterSettings, characterInactiveReason } from "../application/chat/character-settings.js";
import { ChatToolRegistry } from "../application/chat/tools/chat-tool-registry.js";
import { DiscordServerLookupTool } from "../infrastructure/discord/discord-server-lookup-tool.js";
import { DiceRollTool } from "../application/chat/tools/dice-tool.js";
import { EightBallTool } from "../application/chat/tools/eightball-tool.js";
import { BooruSearchTool } from "../application/chat/tools/booru-search-tool.js";
import { MemoryLookupTool } from "../application/chat/tools/memory-lookup-tool.js";
import { BirthdayLookupTool } from "../application/chat/tools/birthday-lookup-tool.js";
import { BirthdaySetTool } from "../application/chat/tools/birthday-set-tool.js";
import { BirthdayMemberSetTool } from "../application/chat/tools/birthday-member-set-tool.js";
import { ReadLinkTool } from "../application/chat/tools/read-link-tool.js";
import { GenerateSelfImageTool } from "../application/chat/tools/generate-self-image-tool.js";
import { CachingEmbeddingsClient } from "../application/chat/caching-embeddings-client.js";
import { RelevantExampleExchangeSelector } from "../application/chat/example-exchange-selector.js";
import { RelevantPersonaLoreSelector } from "../application/chat/persona-lore-selector.js";
import { PersonaBundleCompiler } from "../application/chat/persona-bundle-compiler.js";
import { PersonaDriftStore } from "../application/chat/persona-drift-store.js";
import type { MemoryRepository } from "../application/memory/memory.js";
import { createGuardedMemoryEngine } from "../application/context/guarded-memory-gateway.js";
import type { MemoryEngine } from "../application/memory/memory.js";
import type { ChannelSummaryCheckpointStore } from "../application/context/channel-summary-checkpoint-store.js";
import { ChannelSummaryScheduler } from "../application/context/channel-summary-scheduler.js";
import type { PersonalMemoryExtractionQueueStore } from "../application/context/personal-memory-extraction-queue.js";
import { DiscordChannelHistoryReader } from "../infrastructure/discord/context/discord-channel-history-reader.js";
import { FilePersonaSource } from "../infrastructure/chat/file-persona-source.js";
import { OpenAiEmbeddingsClient } from "../infrastructure/chat/openai-embeddings-client.js";
import { GeminiEmbeddingsClient } from "../infrastructure/chat/gemini-embeddings-client.js";
import { embeddingDimensions } from "../infrastructure/database/schema.js";
import { applicationIcons } from "../infrastructure/discord/campaign/campaign-icons.js";
import { ApplicationEmojiCatalog } from "../infrastructure/discord/application-emoji-catalog.js";
import type { AuditLogService } from "../application/audit/audit-log-service.js";
import { MemberProfileService } from "../application/members/member-profile-service.js";
import type { EmbeddingsClient } from "../application/chat/embeddings-client.js";
import { FileMemoryRelevanceTraceCollector } from "../infrastructure/persistence/file-memory-relevance-trace-collector.js";

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
export function createChatProviderFromConfig(config: ProviderConfig, logger: Logger): ChatProvider {
  return guardModelTransport(instrumentModel(createRawChatProviderFromConfig(config, logger), logger));
}

function createRawChatProviderFromConfig(config: ProviderConfig, logger: Logger): ChatProvider {
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
  // The D&D campaign runtime: started when Discord is ready, stopped on shutdown.
  campaign: CampaignModule;
  commandRegistry: CommandRegistry;
  commandDispatcher: CommandDispatcher;
  // Services built after dependencies (the admin panel) register their
  // component handlers here.
  componentRegistry: ComponentRegistry;
  componentDispatcher: ComponentDispatcher;
  musicPlayerGateway: MusicPlayerGateway;
  guildConfigurationProvider: GuildConfigurationProvider;
  playbackService: PlaybackService;
  pollService: PollService;
  behaviorDispatcher: BehaviorDispatcher;
  // Runs every registered setting, for every surface (/settings-*, the
  // admin panel, guided setup); settingsUpdater saves and notifies.
  settingsEngine: SettingsEngine;
  settingsUpdater: SettingsUpdateService;
  // What's wrong with each guild's admin panel, if anything, for /status.
  adminPanelHealth: AdminPanelHealth;
  // Null when no chat provider is configured — there's nothing to
  // summarize channel messages with, same condition chatConversationService
  // already checks.
  channelSummaryScheduler: ChannelSummaryScheduler | null;
  // Null under the same condition — see ReactionReplyScheduler's own
  // constructor call above.
  reactionReplyScheduler: ReactionReplyScheduler | null;
  // One per bot: every feature that edits the same messages repeatedly
  // registers its slots here, so they share each channel's edit budget.
  channelEditScheduler: ChannelEditScheduler;
  reminderScheduler: ReminderScheduler;
  applicationEmojiCatalog: ApplicationEmojiCatalog;
  memoryEngine: MemoryEngine;
  // Null under the same condition as channelSummaryScheduler above — no
  // chat provider configured. Exposed so Application.stop() can drain its
  // fire-and-forget background writes (dedicated extraction, dropped-
  // exchange consolidation) before the process exits.
  chatConversationService: ChatConversationService | null;
  raidService: RaidService;
  linkGuardService: LinkGuardService;
}

// Everything registerCommands() builds that createDependencies() (or any
// other caller that only wants live command/component instances — see
// scripts/deploy-commands.ts) needs, either as its own return value or to
// keep building the surrounding chat/behavior/scheduler runtime on top of.
export interface CommandRegistrationResult {
  campaign: CampaignModule;
  commandRegistry: CommandRegistry;
  componentRegistry: ComponentRegistry;
  accessPolicyService: AccessPolicyService;
  playbackService: PlaybackService;
  pollService: PollService;
  settingsEngine: SettingsEngine;
  settingsUpdater: SettingsUpdateService;
  // What's wrong with each guild's admin panel, if anything, for /status.
  adminPanelHealth: AdminPanelHealth;
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
  boostHistoryStore: BoostHistoryStore,
  memoryRepository: MemoryRepository,
  channelSummaryCheckpointStore: ChannelSummaryCheckpointStore,
  personalMemoryExtractionQueueStore: PersonalMemoryExtractionQueueStore,
  reminderStore: ReminderStore,
  roleMenuStore: RoleMenuStore,
): CommandRegistrationResult {
  // Invalid translations already fell back to English (see i18n/texts.ts);
  // surface them so they get fixed rather than silently shipping English.
  for (const issue of catalogIssues) {
    logger.warn(issue, "Translation catalog problem; using English for this message");
  }
  const commandRegistry = new CommandRegistry();
  const pollService = new PollService(guildConfigurationProvider);
  const componentRegistry = new ComponentRegistry();
  componentRegistry.register(new PollComponentHandler(pollService));
  const roleMenuService = new RoleMenuService(
    roleMenuStore, logger.child({ component: "role-menu" }), guildConfigurationProvider,
  );
  componentRegistry.register(new RoleMenuComponentHandler(roleMenuService));
  commandRegistry.register(new PingCommand());
  commandRegistry.register(new UserInfoCommand(guildConfigurationProvider, boostHistoryStore));
  commandRegistry.register(new BoostsCommand(boostHistoryStore));
  commandRegistry.register(new QuoteCommand());
  commandRegistry.register(new QuoteContextCommand());
  commandRegistry.register(new DiagnosticCommand(diagnosticStore(logger), configuration.ownerUserIds, () => diagnosticPipelineStatus(logger), null,
    (guildId) => guildId ? guildConfigurationProvider.find(guildId)?.language ?? "en" : "en"));
  commandRegistry.register(new ExplainMessageCommand(diagnosticStore(logger), guildConfigurationProvider));
  const setupCommand = new SetupCommand(guildSetupService);
  commandRegistry.register(setupCommand);
  const adminPanelHealth = new AdminPanelHealth();
  commandRegistry.register(new StatusCommand(guildSetupService, guildConfigurationProvider, adminPanelHealth, {
    chat: configuration.chat
      ? { provider: configuration.chat.provider, models: configuration.chat.models, summaryModels: configuration.chat.summaryModels }
      : null,
    utility: configuration.utilityChat
      ? { provider: configuration.utilityChat.provider, models: configuration.utilityChat.models }
      : null,
    embeddings: configuration.embeddings
      ? { provider: configuration.embeddings.provider, model: configuration.embeddings.model }
      : null,
  }, () => chatProvider?.nativeWebSearchSupported === true, () => chatProvider?.applicationToolsSupported === true,
  () => chatProvider?.imageGenerationSupported === true));
  commandRegistry.register(new VoteCommand(pollService));
  const embeddingsClient = configuration.embeddings
    ? guardEmbeddingTransport(new CachingEmbeddingsClient(
        instrumentModel(configuration.embeddings.provider === "gemini"
          ? new GeminiEmbeddingsClient(configuration.embeddings.apiKey, configuration.embeddings.model, embeddingDimensions)
          : new OpenAiEmbeddingsClient(
              configuration.embeddings.baseUrl,
              configuration.embeddings.apiKey,
              configuration.embeddings.model,
            ), logger),
      ))
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
  componentRegistry.register(new QueuePageComponentHandler(playbackService, guildConfigurationProvider));
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
  const campaign = createCampaignModule({ configuration, logger, client: discordClient, accessPolicyService, icons: applicationIcons((name) => applicationEmojiCatalog.getEmoji(name)) });
  commandRegistry.register(campaign.command);
  componentRegistry.register(campaign.handler);
  componentRegistry.register(campaign.hubHandler);
  componentRegistry.register(campaign.libraryHandler);
  componentRegistry.register(campaign.adventureHandler);

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
  const relevanceEvalSampleRate = configuration.memory.relevanceEvalSampleRate ?? 0;
  const relevanceTraceCollector = relevanceEvalSampleRate > 0
    ? new FileMemoryRelevanceTraceCollector(
        configuration.runtimeDataDirectory,
        relevanceEvalSampleRate,
        configuration.memory.relevanceEvalIncludePrivate ?? false,
      )
    : null;
  const memoryEngine = createGuardedMemoryEngine(
    memoryRepository, embeddingsClient, logger.child({ component: "memory-engine" }), configuration.memory,
    utilityProvider,
    relevanceTraceCollector,
    async (userId) => {
      if (userId === discordClient.user?.id) return true;
      const user = await discordClient.users.fetch(userId);
      return user.bot;
    },
    (guildId) => guildConfigurationProvider.find(guildId)?.chat.sharedMemoryEnabled === true,
    (guildId, channelId) => {
      const profile = guildConfigurationProvider.find(guildId); if (!profile) return null;
      const settings = characterSettings(profile);
      return !characterInactiveReason(settings, "fading", channelId, { context: profile.features.channelHistory, decision: false,
        memorySharing: profile.chat.sharedMemoryEnabled === true, continuation: false, spontaneous: false,
        excluded: !profile.features.chatbot || profile.chat.channelMemoryModes[channelId] === "disabled" }) ? settings.modules.fading.halfLifeDays : null;
    },
  );
  const memberProfileService = new MemberProfileService(memoryEngine, birthdayStore, userCustomizationStore);
  commandRegistry.register(new MemoryCommand(chatStateStore, memberProfileService, memoryEngine, personalMemoryExtractionQueueStore));
  if (relevanceTraceCollector) commandRegistry.register(new MemoryEvalCommand(relevanceTraceCollector));
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
  const settingsUpdater = new SettingsUpdateService(guildConfigurationProvider, guildAssetStore, auditLogService);
  const settingsDeps = {
    chatProviderAvailable: chatProvider !== null,
    assets: guildAssetStore,
    applicationEmojiCatalog,
    auditLogService,
    personaDriftStore,
    campaign: campaign.settings,
    ...(channelSummaryCheckpointStore ? { channelSummaryCheckpointStore } : {}),
    channelSummaryProviderAvailable: utilityProvider?.summarizeChannelMessages !== undefined,
  };
  // Building the engine validates the settings registry and its text, so a
  // registration mistake fails startup rather than a deploy.
  const settingsEngine = new SettingsEngine({
    registry: settingsRegistry,
    profiles: guildConfigurationProvider,
    updater: settingsUpdater,
    deps: settingsDeps,
  });
  const setupGuide = new SetupGuide(settingsEngine, guildConfigurationProvider, logger.child({ component: "setup-guide" }));
  setupCommand.bindGuide(setupGuide);
  componentRegistry.register(new SetupGuideComponentHandler(setupGuide));
  // One top-level /settings-<group> command per group, rather than one
  // shared /settings command: every group's descriptions would otherwise
  // share Discord's 8000-char per-command budget.
  for (const group of settingsRegistry) {
    commandRegistry.register(new SettingsCommand(group, settingsEngine, guildConfigurationProvider));
  }
  commandRegistry.register(new CustomizeCommand(userCustomizationStore, utilityProvider));

  return {
    campaign,
    commandRegistry,
    componentRegistry,
    accessPolicyService,
    playbackService,
    pollService,
    settingsEngine,
    settingsUpdater,
    adminPanelHealth,
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
  boostHistoryStore: BoostHistoryStore,
  memoryRepository: MemoryRepository,
  channelSummaryCheckpointStore: ChannelSummaryCheckpointStore,
  personalMemoryExtractionQueueStore: PersonalMemoryExtractionQueueStore,
  reminderStore: ReminderStore,
  roleMenuStore: RoleMenuStore,
  messageReactionWatchStore: MessageReactionWatchStore,
  messageOriginStore: MessageOriginStore,
  conversationEpisodeStore: ConversationEpisodeStore,
): ApplicationDependencies {
  messageOriginStore = withSessionMessageOrigins(messageOriginStore);
  const {
    campaign,
    commandRegistry,
    componentRegistry,
    accessPolicyService,
    playbackService,
    pollService,
    settingsEngine,
    settingsUpdater,
    adminPanelHealth,
    applicationEmojiCatalog,
    memoryEngine,
    guildAssetStore,
    personaDriftStore,
    embeddingsClient,
    chatProvider,
    utilityProvider,
  } = registerCommands(
    configuration, logger, musicPlayerGateway, guildConfigurationProvider, guildSetupService,
    discordClient, chatStateStore, userCustomizationStore, auditLogService, birthdayStore, boostHistoryStore,
    memoryRepository, channelSummaryCheckpointStore, personalMemoryExtractionQueueStore, reminderStore, roleMenuStore,
  );

  const reminderScheduler = new ReminderScheduler(
    discordClient, reminderStore, logger.child({ component: "reminders" }), guildConfigurationProvider,
  );

  const commandDispatcher = new CommandDispatcher(
    commandRegistry,
    accessPolicyService,
    logger.child({ component: "commands" }),
    // Read per interaction, so a /settings language change applies to the
    // very next command.
    (guildId) => (guildId ? guildConfigurationProvider.find(guildId)?.language : undefined) ?? defaultLanguage,
    messageOriginStore,
  );
  const componentDispatcher = new ComponentDispatcher(
    componentRegistry,
    accessPolicyService,
    logger.child({ component: "components" }),
  );
  const behaviorRegistry = new BehaviorRegistry();
  const channelEditScheduler = new ChannelEditScheduler();
  const isGameChannel = (guildId: string, channelIds: readonly string[]): Promise<boolean> => campaign.isGameChannel(guildId, channelIds);
  const socialEligibility = new SocialChatEligibility(configuration, guildConfigurationProvider, messageOriginStore, isGameChannel);
  socialEligibility.bindGuardedForgetPolicy((message) => memoryRepository.isSourceForgotten({ guildId: message.guildId!,
    subjectId: message.author.id, topic: "*", slot: `source:${message.id}`, channelId: message.channelId, sourceTimestampMs: message.createdTimestamp }));

  // Prefers the cheaper utility model when configured, same preference as
  // ChatConversationService's own consolidation call. Null when no chat
  // provider is configured, or the configured one doesn't implement
  // summarizeChannelMessages — narrowing to ChannelMessageSummarizer here
  // (rather than passing the full ChatProvider) makes that a wiring-time
  // check instead of the scheduler probing an optional method at runtime.
  const channelSummaryScheduler = utilityProvider?.summarizeChannelMessages
    ? new ChannelSummaryScheduler(
        new DiscordChannelHistoryReader(discordClient, socialEligibility), guildConfigurationProvider, memoryEngine,
        channelSummaryCheckpointStore, personalMemoryExtractionQueueStore,
        {
          summarizeChannelMessages: utilityProvider.summarizeChannelMessages.bind(utilityProvider),
          // Optional — see ChannelSummaryScheduler's own promotion-path
          // comment. Bound only when the provider actually implements it
          // (omitted entirely, not set to undefined, per
          // exactOptionalPropertyTypes), same narrowing rationale as
          // summarizeChannelMessages above.
          ...(utilityProvider.extractPersonalMemories
            ? { extractPersonalMemories: utilityProvider.extractPersonalMemories.bind(utilityProvider) }
            : {}),
        },
        logger.child({ component: "channel-summary-scheduler" }),
      )
    : null;
  // Derived from CommandRegistry rather than hand-listed: any BotCommand
  // that sets `toolBinding` (see command.ts) is automatically offered to the
  // model, so a command's LLM exposure has one source of truth — the
  // command file itself — instead of a second array to keep in sync here.
  const commandToolBindings = commandRegistry.getAll().flatMap((command) =>
    command.toolBinding ? [ReviewedMusicTool.from(command) ?? command.toolBinding] : []);
  const chatToolRegistry = new ChatToolRegistry([
    new DiceRollTool(),
    new EightBallTool(),
    new BooruSearchTool(),
    new MemoryLookupTool(memoryEngine),
    new DiscordServerLookupTool(discordClient, guildConfigurationProvider),
    new BirthdayLookupTool(birthdayStore, guildConfigurationProvider),
    new BirthdaySetTool(birthdayStore, guildConfigurationProvider),
    new BirthdayMemberSetTool(birthdayStore, guildConfigurationProvider, async (guildId, userId) => {
      const guild = discordClient.guilds.cache.get(guildId);
      if (!guild) return null;
      const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
      return member ? [...member.roles.cache.keys()] : null;
    }),
    new ReadLinkTool(),
    // Needs a real ChatProvider to make its own isolated image-generation
    // request (see ChatProvider.generateReferenceImage) — omitted entirely
    // when no chat provider is configured, same as chatConversationService
    // below being skipped in that case.
    ...(chatProvider ? [new GenerateSelfImageTool(guildAssetStore, guildConfigurationProvider, chatProvider)] : []),
    ...commandToolBindings,
  ]);
  settingsEngine.bindChatToolRegistry(chatToolRegistry);
  const structuredUtility = utilityProvider?.generateCharacterData ? { generateCharacterData: utilityProvider.generateCharacterData.bind(utilityProvider) } : null;
  const structuredReply = chatProvider?.generateCharacterData ? { generateCharacterData: chatProvider.generateCharacterData.bind(chatProvider) } : null;
  const dedicatedDecision = configuration.decision ? guardModelTransport(instrumentModel(new HttpDecisionProvider(configuration.decision), logger)) : null;
  const contextualProviders = contextualDecisionProviders(dedicatedDecision, structuredReply, structuredUtility);
  logger.info({ contextualDecisionSource: contextualProviders.source, contextualDecisionModel: configuration.decision?.model ??
    (contextualProviders.source === "reply" || !configuration.utilityChat ? configuration.chat?.summaryModels[0] : configuration.utilityChat.models[0]) ?? null,
    contextualFallbackSource: contextualProviders.fallback ? "reply" : null }, "Contextual decision provider selection");
  const characterRuntime = chatProvider ? new CharacterRuntime(guildConfigurationProvider, memoryRepository,
    structuredUtility,
    chatProvider, dedicatedDecision ?? structuredUtility, personalMemoryExtractionQueueStore, undefined, logger.child({ component: "character" }), contextualProviders) : null;
  if (characterRuntime) settingsEngine.bindCharacterRuntime(characterRuntime);
  const diagnosticCommand = commandRegistry.getAll().find((command): command is DiagnosticCommand => command instanceof DiagnosticCommand);
  diagnosticCommand?.bindProviderHealth({ decision: () => characterRuntime?.decisionHealth ?? null, generation: () => modelGenerationHealth(logger),
    checkDecision: () => characterRuntime?.checkDecisionHealth() ?? Promise.resolve(null) });
  characterRuntime?.bindTargetPreferences(async (guildId, userId) => ({ customization: await userCustomizationStore.load(guildId, userId) }));
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
        personalMemoryExtractionQueueStore,
        conversationEpisodeStore,
        characterRuntime,
      )
    : null;
  chatConversationService?.bindContextForgetRecorder(async (guildId, userId, cutoff) => {
    // The durable cutoff blocks late writes and read-time reuse first. Other
    // members' derived session text is removed when its footprint names this subject.
    await memoryRepository.recordForgetCutoff({ guildId, subjectId: userId, topic: "*", slot: "*", scopeKey: "*", cutoff });
    const results = await Promise.allSettled([messageOriginStore.invalidateContextSubject?.(guildId, userId), chatStateStore.invalidateContextSubject?.(guildId, userId)]);
    if (results.some((result) => result.status === "rejected")) throw new Error("Context source invalidation was incomplete");
  });
  const personaSource = new FilePersonaSource(
    configuration.runtimeDataDirectory,
    logger.child({ component: "persona-source" }),
    personaDriftStore,
    embeddingsClient,
    guildConfigurationProvider,
  );
  if (characterRuntime) {
    characterRuntime.bindPersonaVersion(async (guildId) => (await personaSource.resolve(guildConfigurationProvider.require(guildId))).personalitySourceHash);
    const evaluationStore = new CharacterEvaluationStore(configuration.runtimeDataDirectory);
    characterRuntime.bindEvaluationStore(evaluationStore);
    commandRegistry.register(new FeltLikeBotCommand(guildConfigurationProvider, messageOriginStore, evaluationStore));
    const evaluationRequest = async (guildId: string, channelId: string, userId: string, question: string): Promise<GuardedEvaluationContext> => {
      const profile = guildConfigurationProvider.require(guildId); const persona = await personaSource.resolve(profile);
      if (!persona.configurationContext) throw new Error("Evaluation persona authority unavailable");
      const fingerprint = (): string => JSON.stringify(guildConfigurationProvider.find(guildId),
        (_key, value: unknown) => value instanceof Set ? [...value].sort() : value);
      const expected = fingerprint();
      return GuardedEvaluationContext.open({ guildId, channelId, reviewerId: userId }, persona.configurationContext, question, characterSettings(profile), async () => {
        const current = guildConfigurationProvider.find(guildId);
        if (!current || fingerprint() !== expected || !characterSettings(current).modules.evaluation.enabled) return false;
        if (userId === "character-evaluation") return characterSettings(current).modules.evaluation.probes && interviewProbes.some((probe) => probe === question);
        const guild = discordClient.guilds.cache.get(guildId) ?? await discordClient.guilds.fetch(guildId).catch(() => null);
        const member = await guild?.members.fetch({ user: userId, force: true }).catch(() => null);
        if (!member) return false;
        return accessPolicyService.evaluateMember(settingsAccessPolicy, CommandModule.Diagnostics, { guildId, channelId, userId,
          roleIds: [...member.roles.cache.keys()], memberPermissions: member.permissions.bitfield, botPermissions: guild?.members.me?.permissions.bitfield ?? null }).allowed;
      });
    };
    characterRuntime.bindCallbackPersona(async (guildId) => {
      const persona = await personaSource.resolve(guildConfigurationProvider.require(guildId));
      if (!persona.configurationContext) throw new Error("Callback persona authority unavailable"); return persona.configurationContext;
    });
    characterRuntime.bindProbeSchedule((guildId, channelId, question) => evaluationRequest(guildId, channelId, "character-evaluation", question));
    channelSummaryScheduler?.bindCharacterConsolidation((context, subjectIds) => characterRuntime.afterMemoryConsolidation(context, subjectIds));
    commandRegistry.register(new CharacterEvalCommand(guildConfigurationProvider, messageOriginStore, evaluationStore, characterRuntime, evaluationRequest));
  }
  if (chatConversationService) for (const command of commandRegistry.getAll()) {
    if (command instanceof MemoryCommand) command.bindConversationForget((guildId, userId) => chatConversationService.forgetConversation(guildId, userId));
  }
  if (characterRuntime && chatConversationService) {
    characterRuntime.bindEvaluationAdmission({ run: (guildId, channelId, operation, cost) => chatConversationService.runCharacterEvaluation(guildId, channelId,
      resolveParticipation(guildConfigurationProvider.find(guildId)?.chat.participation, channelId).limits, operation, cost) });
    const resolveCallbackSource = async (guildId: string, channelId: string, sourceMessageId: string): Promise<Message<true> | null> => {
      const channel = await discordClient.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== guildId) return null;
      const message = await channel.messages.fetch(sourceMessageId).catch(() => null);
      return message && (await socialEligibility.check(message, "continuation")).eligible ? message : null;
    };
    const callbackSources = new ChatTurnSupport(logger.child({ component: "callback-context" }), socialEligibility, messageOriginStore);
    characterRuntime.bindCallbackDelivery({
      context: async (guildId, channelId, sourceMessageId) => {
        const source = await resolveCallbackSource(guildId, channelId, sourceMessageId); if (!source) return null;
        const persona = await personaSource.resolve(guildConfigurationProvider.require(guildId));
        const contextConfiguration = await conversationConfiguration(guildId, source.author.id, persona.configurationContext, userCustomizationStore);
        return guardedToolResourcePort(callbackSources.createContextPort(source), chatToolRegistry, {
          currentUser: callbackSources.toChatUser(source.author, source.member), channelMode: resolveChannelMemoryMode(guildConfigurationProvider.require(guildId).chat.channelMemoryModes, channelId),
          channelIsNsfw: "nsfw" in source.channel && source.channel.nsfw, isOwner: configuration.ownerUserIds.has(source.author.id),
        }, undefined, contextConfiguration, personaDriftStore, (id) => characterRuntime.readCharacterConfiguration(guildId, channelId, id));
      },
      run: (guildId, channelId, operation) => chatConversationService.runCallback(guildId, channelId,
        resolveParticipation(guildConfigurationProvider.find(guildId)?.chat.participation, channelId).limits, operation),
      check: async (guildId, channelId, sourceMessageId) => !!await resolveCallbackSource(guildId, channelId, sourceMessageId),
      send: async (guildId, channelId, sourceMessageId, text, replyToMessageId, context) => {
        const source = await resolveCallbackSource(guildId, channelId, sourceMessageId);
        if (!source) throw new SocialOutputSuppressed();
        const eventSource = replyToMessageId ? await resolveCallbackSource(guildId, channelId, replyToMessageId) : null;
        const replyTarget = eventSource?.author.id === source.author.id ? eventSource : null;
        const payload = { content: text, allowedMentions: { parse: [], repliedUser: false } };
        if (!isGuardedContext(context) || !await context.validate()) throw new SocialOutputSuppressed();
        const contextProvenance = context.provenance(text); if (!contextProvenance) throw new SocialOutputSuppressed();
        const sent = replyTarget ? await replyTarget.reply(payload) : await source.channel.send(payload);
        await messageOriginStore.record({ guildId, channelId, messageId: sent.id, origin: "chat", sourceMessageId, createdAt: Date.now(), contextProvenance });
        chatConversationService.observe(guildId, channelId, { messageId: sent.id, timestampMs: Date.now(), authorId: discordClient.user!.id,
          authorDisplayName: guildConfigurationProvider.require(guildId).displayName, content: text, imageCount: 0,
          ...(replyTarget ? { replyToMessageId: replyTarget.id, replyToAuthorId: replyTarget.author.id } : {}),
          author: { id: discordClient.user!.id, displayName: guildConfigurationProvider.require(guildId).displayName, roleNames: [], kind: "bot" } });
        return sent.id;
      },
    });
  }
  const reactionReplyScheduler = chatConversationService
    ? new ReactionReplyScheduler(
        discordClient, messageReactionWatchStore, guildConfigurationProvider, chatConversationService,
        personaSource, logger.child({ component: "reaction-reply-scheduler" }), configuration,
        isGameChannel,
        socialEligibility, messageOriginStore,
      )
    : null;
  if (chatConversationService) behaviorRegistry.register(new ConversationObservationBehavior(
    chatConversationService, guildConfigurationProvider, socialEligibility, logger.child({ component: "chat-observation" }),
  ));
  behaviorRegistry.register(new MentionChatBehavior(
    () => discordClient.user?.id ?? null,
    configuration,
    guildConfigurationProvider,
    chatConversationService,
    personaSource,
    logger.child({ component: "chat" }),
    messageReactionWatchStore,
    isGameChannel,
    socialEligibility, messageOriginStore, channelEditScheduler,
  ));
  const ambientChatBehavior = new AmbientChatBehavior(
    () => discordClient.user?.id ?? null,
    configuration,
    guildConfigurationProvider,
    chatConversationService,
    personaSource,
    logger.child({ component: "ambient-chat" }),
    messageReactionWatchStore,
    isGameChannel,
    socialEligibility, messageOriginStore,
  );
  behaviorRegistry.register(ambientChatBehavior);
  if (chatConversationService) behaviorRegistry.register(new ProactiveChatBehavior(
    () => discordClient.user?.id ?? null, guildConfigurationProvider, chatConversationService,
    socialEligibility, ambientChatBehavior, logger.child({ component: "proactive-chat" }),
  ));
  behaviorRegistry.register(new ReactionArmBehavior(
    () => discordClient.user?.id ?? null,
    messageReactionWatchStore,
    guildConfigurationProvider,
    logger.child({ component: "reaction-arm" }),
  ));
  const linkGuardService = new LinkGuardService(guildConfigurationProvider, logger.child({ component: "link-guard" }));
  behaviorRegistry.register(new SpamGuardBehavior(
    new SpamService(guildConfigurationProvider, logger.child({ component: "spam-guard" })),
    linkGuardService,
  ));
  behaviorRegistry.register(new TrapChannelBehavior(
    guildConfigurationProvider,
    new TrapService(guildConfigurationProvider, logger.child({ component: "trap-channel" })),
  ));
  behaviorRegistry.register(new LinkFixBehavior(
    guildConfigurationProvider,
    logger.child({ component: "link-fix" }),
    isGameChannel,
    messageOriginStore,
    socialEligibility, chatConversationService,
  ));

  return {
    campaign,
    commandRegistry,
    commandDispatcher,
    componentRegistry,
    componentDispatcher,
    musicPlayerGateway,
    guildConfigurationProvider,
    playbackService,
    pollService,
    behaviorDispatcher: new BehaviorDispatcher(behaviorRegistry, logger.child({ component: "behavior-dispatcher" })),
    settingsEngine,
    settingsUpdater,
    adminPanelHealth,
    channelSummaryScheduler,
    reactionReplyScheduler,
    channelEditScheduler,
    reminderScheduler,
    applicationEmojiCatalog,
    memoryEngine,
    chatConversationService,
    raidService: new RaidService(guildConfigurationProvider, logger.child({ component: "raid-guard" })),
    linkGuardService,
  };
}
