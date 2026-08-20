import { Client, Events, GatewayIntentBits } from "discord.js";
import type { Logger } from "pino";

import type { ApplicationDependencies } from "./dependencies.js";
import type { ApplicationConfiguration } from "../config/configuration.js";
import type { ControlChannelService } from "../application/control-panel/control-channel-service.js";
import { BehaviorEvent } from "../application/behaviors/behavior.js";
import type { MusicPresenceService } from "../application/music/music-presence-service.js";
import type { BirthdayAnnouncer } from "../application/birthdays/birthday-announcer.js";
import type { MemberDepartureService } from "../application/members/member-departure-service.js";

export class Application {
  public constructor(
    private readonly client: Client,
    private readonly configuration: ApplicationConfiguration,
    private readonly dependencies: ApplicationDependencies,
    private readonly controlChannelService: ControlChannelService,
    private readonly musicPresenceService: MusicPresenceService,
    private readonly birthdayAnnouncer: BirthdayAnnouncer,
    private readonly memberDepartureService: MemberDepartureService,
    private readonly logger: Logger,
    private readonly onFatalError?: (reason: string) => void,
  ) {
    this.registerDiscordEvents();
  }

  public async start(): Promise<void> {
    const profiles = this.dependencies.guildConfigurationProvider.getAll();
    this.logger.info({
      instanceName: this.configuration.instanceName ?? "default",
      environment: this.configuration.environment,
      persistenceDriver: this.configuration.persistence.driver,
      chat: this.configuration.chat
        ? {
            configured: true,
            provider: this.configuration.chat.provider,
            models: this.configuration.chat.models,
            maxOutputTokens: this.configuration.chat.maxOutputTokens,
            ...(this.configuration.chat.provider === "openai-responses"
              ? { reasoningEffort: this.configuration.chat.reasoningEffort, verbosity: this.configuration.chat.verbosity }
              : {}),
            ...(this.configuration.chat.provider === "gemini"
              ? { thinkingBudget: this.configuration.chat.thinkingBudget }
              : {}),
          }
        : { configured: false },
      guilds: profiles.map((profile) => ({
        guildId: profile.guildId,
        guildName: profile.guildName,
        features: Object.entries(profile.features)
          .filter(([, enabled]) => enabled)
          .map(([feature]) => feature),
        chat: {
          enabled: profile.features.chatbot,
          personalityConfigured: Boolean(profile.chat.personalityAsset ?? profile.chat.personalityFile),
          webSearchMode: profile.chat.webSearchMode,
          imageInputEnabled: profile.chat.imageInputEnabled,
          includeSources: profile.chat.includeSources,
          maxImagesPerRequest: profile.chat.maxImagesPerRequest,
        },
      })),
    }, "Application configuration loaded");
    this.logger.info("Starting Discord client");
    await this.client.login(this.configuration.discord.token);
  }

  public async stop(reason: string): Promise<void> {
    this.logger.info({ reason }, "Stopping application");
    this.controlChannelService.stop();
    this.musicPresenceService.stop();
    this.birthdayAnnouncer.stop();
    this.dependencies.pollService.stop();
    await this.client.destroy();
  }

  private registerDiscordEvents(): void {
    this.client.once(Events.ClientReady, (readyClient) => {
      this.logger.info(
        {
          botUserId: readyClient.user.id,
          botUsername: readyClient.user.username,
          guildCount: readyClient.guilds.cache.size,
        },
        "Discord client ready",
      );

      const configuredGuildIds = new Set(
        this.dependencies.guildConfigurationProvider
          .getAll()
          .map((profile) => profile.guildId),
      );
      const unconfiguredGuildIds = readyClient.guilds.cache
        .filter((guild) => !configuredGuildIds.has(guild.id))
        .map((guild) => guild.id);

      if (unconfiguredGuildIds.length > 0) {
        this.logger.warn(
          { unconfiguredGuildIds },
          "Bot is present in guilds without local profiles; commands will be denied there",
        );
      }

      void this.dependencies.musicPlayerGateway
        .initialize({
          id: readyClient.user.id,
          username: readyClient.user.username,
        })
        .catch((error: unknown) => {
          this.logger.fatal({ error }, "Lavalink initialization failed");
          if (this.onFatalError) {
            this.onFatalError("lavalink-init-failed");
            return;
          }
          void this.stop("lavalink-init-failed");
        });

      void (async (): Promise<void> => {
        try {
          await this.dependencies.applicationEmojiCatalog.initialize();
        } catch (error) {
          this.logger.error({ error }, "Application emoji catalog initialization failed");
        }
        await this.controlChannelService.initialize();
      })().catch((error: unknown) => {
        this.logger.error({ error }, "Control-channel initialization failed");
      });
      this.musicPresenceService.start();
      this.birthdayAnnouncer.start();
    });

    this.client.on(Events.Raw, (payload) => {
      this.dependencies.musicPlayerGateway.acceptDiscordGatewayPayload(payload);
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isButton()) {
        void (async (): Promise<void> => {
          if (await this.controlChannelService.handleButton(interaction)) return;
          await this.dependencies.componentDispatcher.dispatch(interaction);
        })().catch((error: unknown) => {
          this.logger.error({ error }, "Button dispatch failed");
        });
        return;
      }

      if (!interaction.isChatInputCommand()) {
        return;
      }

      void this.dependencies.commandDispatcher.dispatch(interaction).catch((error: unknown) => {
        this.logger.error({ error }, "Interaction dispatch failed");
      });
    });

    this.client.on(Events.MessageCreate, (message) => {
      void (async (): Promise<void> => {
        if (await this.controlChannelService.handleMessage(message)) return;
        await this.dependencies.behaviorDispatcher.dispatch(BehaviorEvent.MessageCreated, message);
      })().catch((error: unknown) => {
        this.logger.error({ error }, "Message behavior dispatch failed");
      });
    });

    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const guildId = newState.guild.id;
      if (
        newState.id === this.client.user?.id &&
        oldState.channelId !== null &&
        newState.channelId !== oldState.channelId &&
        this.dependencies.musicPlayerGateway.hasPlayer(guildId)
      ) {
        void this.dependencies.musicPlayerGateway
          .handleBotVoiceDisconnect(guildId)
          .catch((error: unknown) => {
            this.logger.error({ error, guildId }, "Unable to clean up disconnected voice player");
          });
        return;
      }

      const playerChannelId = this.dependencies.musicPlayerGateway.getVoiceChannelId(guildId);
      if (!playerChannelId) return;
      if (oldState.channelId !== playerChannelId && newState.channelId !== playerChannelId) return;
      const channel = newState.guild.channels.cache.get(playerChannelId);
      if (!channel?.isVoiceBased()) return;
      const humanMemberCount = channel.members.filter((member) => !member.user.bot).size;
      this.dependencies.musicPlayerGateway.handleVoiceChannelOccupancy(
        guildId,
        humanMemberCount,
      );
    });

    this.client.on(Events.GuildDelete, (guild) => {
      this.controlChannelService.handleGuildRemoved(guild.id);
      void this.dependencies.musicPlayerGateway.handleGuildRemoved(guild.id).catch((error: unknown) => {
        this.logger.error({ error, guildId: guild.id }, "Unable to clean up music player after leaving guild");
      });
    });

    this.client.on(Events.GuildMemberRemove, (member) => {
      void this.memberDepartureService.handleMemberLeave(member.guild.id, member.id).catch((error: unknown) => {
        this.logger.error({ error, guildId: member.guild.id, userId: member.id }, "Unable to process member departure");
      });
    });

    this.client.on(Events.Error, (error) => {
      this.logger.error({ error }, "Discord client error");
    });

    this.client.on(Events.Warn, (message) => {
      this.logger.warn({ message }, "Discord client warning");
    });
  }
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildExpressions,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
      // Privileged intent, needed to receive GuildMemberRemove (member
      // departure cleanup). Must be enabled for this bot application in the
      // Discord Developer Portal, or the gateway connection will be rejected.
      GatewayIntentBits.GuildMembers,
    ],
  });
}
