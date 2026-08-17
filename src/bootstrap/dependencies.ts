import type { Logger } from "pino";

import { AccessPolicyService } from "../application/access/access-policy-service.js";
import { CommandDispatcher } from "../application/commands/command-dispatcher.js";
import { CommandRegistry } from "../application/commands/command-registry.js";
import type { ApplicationConfiguration } from "../config/configuration.js";
import { PlaybackService } from "../application/music/playback-service.js";
import type { MusicPlayerGateway } from "../application/music/music-player-gateway.js";
import type { GuildConfigurationProvider } from "../config/guild-configuration-provider.js";
import { PingCommand } from "../infrastructure/discord/commands/common/ping-command.js";
import { DiagnosticCommand } from "../infrastructure/discord/commands/diagnostics/diagnostic-command.js";
import { PauseCommand } from "../infrastructure/discord/commands/music/pause-command.js";
import { PlayCommand } from "../infrastructure/discord/commands/music/play-command.js";
import { ResumeCommand } from "../infrastructure/discord/commands/music/resume-command.js";
import { StopCommand } from "../infrastructure/discord/commands/music/stop-command.js";
import { SkipCommand } from "../infrastructure/discord/commands/music/skip-command.js";
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
import { PollService } from "../application/polls/poll-service.js";
import { BehaviorRegistry } from "../application/behaviors/behavior-registry.js";
import { BehaviorDispatcher } from "../application/behaviors/behavior-dispatcher.js";
import { MentionChatBehavior } from "../infrastructure/discord/behaviors/mention-chat-behavior.js";
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
import { FullGuildMemorySelector } from "../application/chat/guild-memory-selector.js";
import { ApplicationEmojiCatalog } from "../infrastructure/discord/application-emoji-catalog.js";

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
  guildKnowledgeStore: GuildKnowledgeStore,
): ApplicationDependencies {
  const commandRegistry = new CommandRegistry();
  const pollService = new PollService();
  const componentRegistry = new ComponentRegistry();
  componentRegistry.register(new PollComponentHandler(pollService));
  const guildAssetStore = new GuildAssetStore(configuration.runtimeDataDirectory);
  const applicationEmojiCatalog = new ApplicationEmojiCatalog(discordClient, logger);
  const settingsCommand = new SettingsCommand(
    guildConfigurationProvider,
    guildAssetStore,
    applicationEmojiCatalog,
  );
  commandRegistry.register(new PingCommand());
  commandRegistry.register(new DiagnosticCommand());
  commandRegistry.register(new SetupCommand(guildSetupService));
  commandRegistry.register(settingsCommand);
  commandRegistry.register(new VoteCommand(pollService));
  const playbackService = new PlaybackService(musicPlayerGateway);
  commandRegistry.register(new PlayCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new PauseCommand(playbackService));
  commandRegistry.register(new ResumeCommand(playbackService));
  commandRegistry.register(new StopCommand(playbackService));
  commandRegistry.register(new SkipCommand(playbackService));
  commandRegistry.register(new PreviousCommand(playbackService));
  commandRegistry.register(new ShuffleCommand(playbackService));
  commandRegistry.register(new QueueCommand(playbackService));
  commandRegistry.register(new LoopCommand(playbackService));
  commandRegistry.register(new VolumeCommand(playbackService, guildConfigurationProvider));
  commandRegistry.register(new AutoplayCommand(playbackService));
  commandRegistry.register(new TwentyFourSevenCommand(playbackService));

  const accessPolicyService = new AccessPolicyService(
    configuration,
    guildConfigurationProvider,
  );
  const commandDispatcher = new CommandDispatcher(
    commandRegistry,
    accessPolicyService,
    logger,
  );
  const componentDispatcher = new ComponentDispatcher(
    componentRegistry,
    accessPolicyService,
    logger,
  );
  const behaviorRegistry = new BehaviorRegistry();
  const chatProvider = configuration.chat
    ? configuration.chat.mode === "responses"
      ? new OpenAiResponsesChatProvider(
          configuration.chat.baseUrl,
          configuration.chat.apiKey,
          configuration.chat.model,
        )
      : new OpenAiCompatibleChatProvider(
          configuration.chat.baseUrl,
          configuration.chat.apiKey,
          configuration.chat.model,
        )
    : null;
  const chatConversationService = chatProvider
    ? new ChatConversationService(
        chatProvider,
        chatStateStore,
        guildKnowledgeStore,
        new FullGuildMemorySelector(),
      )
    : null;
  behaviorRegistry.register(new MentionChatBehavior(
    () => discordClient.user?.id ?? null,
    configuration,
    guildConfigurationProvider,
    chatConversationService,
    logger,
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
