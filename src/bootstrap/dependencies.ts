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
import { HelpCommand } from "../infrastructure/discord/commands/common/help-command.js";
import { BirthdayCommand } from "../infrastructure/discord/commands/common/birthday-command.js";
import type { BirthdayStore } from "../application/birthdays/birthday-store.js";
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
import { OpenAiCompatibleChatProvider } from "../infrastructure/chat/openai-compatible-chat-provider.js";
import { OpenAiResponsesChatProvider } from "../infrastructure/chat/openai-responses-chat-provider.js";
import type { Client } from "discord.js";
import { GuildAssetStore } from "../application/assets/guild-asset-store.js";
import { ComponentRegistry } from "../application/components/component-registry.js";
import { ComponentDispatcher } from "../application/components/component-dispatcher.js";
import { PollComponentHandler } from "../infrastructure/discord/components/poll-component-handler.js";
import type { ChatStateStore } from "../application/chat/chat-state-store.js";
import { ChatConversationService } from "../application/chat/chat-conversation-service.js";
import type { GuildKnowledgeStore } from "../application/chat/guild-knowledge-store.js";
import { RelevantGuildMemorySelector } from "../application/chat/guild-memory-selector.js";
import { ApplicationEmojiCatalog } from "../infrastructure/discord/application-emoji-catalog.js";
import type { AuditLogService } from "../application/audit/audit-log-service.js";
import { MemberProfileService } from "../application/members/member-profile-service.js";

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
  applicationEmojiCatalog: ApplicationEmojiCatalog;
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
  guildKnowledgeStore: GuildKnowledgeStore,
  auditLogService: AuditLogService,
  birthdayStore: BirthdayStore,
): ApplicationDependencies {
  const commandRegistry = new CommandRegistry();
  const pollService = new PollService();
  const componentRegistry = new ComponentRegistry();
  componentRegistry.register(new PollComponentHandler(pollService));
  const guildAssetStore = new GuildAssetStore(configuration.runtimeDataDirectory);
  const applicationEmojiCatalog = new ApplicationEmojiCatalog(
    discordClient,
    logger.child({ component: "emoji-catalog" }),
  );
  const settingsCommand = new SettingsCommand(
    guildConfigurationProvider,
    guildAssetStore,
    applicationEmojiCatalog,
    auditLogService,
  );
  commandRegistry.register(new PingCommand());
  commandRegistry.register(new UserInfoCommand(guildConfigurationProvider));
  commandRegistry.register(new DiagnosticCommand());
  commandRegistry.register(new SetupCommand(guildSetupService));
  commandRegistry.register(settingsCommand);
  commandRegistry.register(new VoteCommand(pollService));
  const memberProfileService = new MemberProfileService(chatStateStore, birthdayStore, userCustomizationStore);
  commandRegistry.register(new MemoryCommand(chatStateStore, memberProfileService));
  commandRegistry.register(new BirthdayCommand(birthdayStore));
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
  commandRegistry.register(new PauseCommand(playbackService));
  commandRegistry.register(new ResumeCommand(playbackService));
  commandRegistry.register(new StopCommand(playbackService));
  commandRegistry.register(new SkipCommand(playbackService));
  commandRegistry.register(new SkipToCommand(playbackService));
  commandRegistry.register(new PreviousCommand(playbackService));
  commandRegistry.register(new ShuffleCommand(playbackService));
  commandRegistry.register(new QueueCommand(playbackService));
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
  const chatProvider = configuration.chat
    ? configuration.chat.mode === "responses"
      ? new OpenAiResponsesChatProvider(
          configuration.chat.baseUrl,
          configuration.chat.apiKey,
          configuration.chat.model,
          {
            reasoningEffort: configuration.chat.reasoningEffort,
            verbosity: configuration.chat.verbosity,
            maxOutputTokens: configuration.chat.maxOutputTokens,
          },
        )
      : new OpenAiCompatibleChatProvider(
          configuration.chat.baseUrl,
          configuration.chat.apiKey,
          configuration.chat.model,
          logger.child({ component: "chat-provider" }),
        )
    : null;
  commandRegistry.register(new CustomizeCommand(userCustomizationStore, chatProvider));
  const chatConversationService = chatProvider
    ? new ChatConversationService(
        chatProvider,
        chatStateStore,
        guildKnowledgeStore,
        new RelevantGuildMemorySelector(),
        undefined,
        userCustomizationStore,
        undefined,
        birthdayStore,
      )
    : null;
  behaviorRegistry.register(new MentionChatBehavior(
    () => discordClient.user?.id ?? null,
    configuration,
    guildConfigurationProvider,
    chatConversationService,
    logger.child({ component: "chat" }),
  ));
  behaviorRegistry.register(new AmbientChatBehavior(
    () => discordClient.user?.id ?? null,
    configuration,
    guildConfigurationProvider,
    chatConversationService,
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
    applicationEmojiCatalog,
  };
}
