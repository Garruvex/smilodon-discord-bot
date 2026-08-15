import { Client, Events, GatewayIntentBits } from "discord.js";
import type { Logger } from "pino";

import type { ApplicationDependencies } from "./dependencies.js";
import type { ApplicationConfiguration } from "../config/configuration.js";
import type { ControlChannelService } from "../application/control-panel/control-channel-service.js";
import { BehaviorEvent } from "../application/behaviors/behavior.js";
import type { MusicPresenceService } from "../application/music/music-presence-service.js";

export class Application {
  public constructor(
    private readonly client: Client,
    private readonly configuration: ApplicationConfiguration,
    private readonly dependencies: ApplicationDependencies,
    private readonly controlChannelService: ControlChannelService,
    private readonly musicPresenceService: MusicPresenceService,
    private readonly logger: Logger,
  ) {
    this.registerDiscordEvents();
  }

  public async start(): Promise<void> {
    this.logger.info("Starting Discord client");
    await this.client.login(this.configuration.discord.token);
  }

  public async stop(reason: string): Promise<void> {
    this.logger.info({ reason }, "Stopping application");
    this.controlChannelService.stop();
    this.musicPresenceService.stop();
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
        });

      void this.controlChannelService.initialize().catch((error: unknown) => {
        this.logger.error({ error }, "Control-channel initialization failed");
      });
      this.musicPresenceService.start();
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
      const playerChannelId = this.dependencies.musicPlayerGateway.getVoiceChannelId(guildId);
      if (!playerChannelId) return;
      if (
        newState.id === this.client.user?.id &&
        oldState.channelId === playerChannelId &&
        newState.channelId !== playerChannelId
      ) {
        void this.dependencies.musicPlayerGateway
          .handleBotVoiceDisconnect(guildId)
          .catch((error: unknown) => {
            this.logger.error({ error, guildId }, "Unable to clean up disconnected voice player");
          });
        return;
      }
      if (oldState.channelId !== playerChannelId && newState.channelId !== playerChannelId) return;
      const channel = newState.guild.channels.cache.get(playerChannelId);
      if (!channel?.isVoiceBased()) return;
      const humanMemberCount = channel.members.filter((member) => !member.user.bot).size;
      this.dependencies.musicPlayerGateway.handleVoiceChannelOccupancy(
        guildId,
        humanMemberCount,
      );
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
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
    ],
  });
}
