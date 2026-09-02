import { Client, Events, GatewayIntentBits, MessageFlags, type Message } from "discord.js";
import type { Logger } from "pino";

import type { ApplicationDependencies } from "./dependencies.js";
import type { ApplicationConfiguration } from "../config/configuration.js";
import type { ControlChannelService } from "../application/control-panel/control-channel-service.js";
import { BehaviorEvent } from "../application/behaviors/behavior.js";
import type { MusicPresenceService } from "../application/music/music-presence-service.js";
import type { BirthdayAnnouncer } from "../application/birthdays/birthday-announcer.js";
import type { MemberDepartureService } from "../application/members/member-departure-service.js";
import type { MemberWelcomeService } from "../application/members/member-welcome-service.js";

export class Application {
  // Flips true once Lavalink and the control-panel (emoji catalog +
  // control-channel) have finished initializing after ClientReady. Until
  // then, interactions are rejected with a "still starting up" reply instead
  // of reaching a music/control-panel handler that isn't ready yet.
  private ready = false;

  public constructor(
    private readonly client: Client,
    private readonly configuration: ApplicationConfiguration,
    private readonly dependencies: ApplicationDependencies,
    private readonly controlChannelService: ControlChannelService,
    private readonly musicPresenceService: MusicPresenceService,
    private readonly birthdayAnnouncer: BirthdayAnnouncer,
    private readonly memberDepartureService: MemberDepartureService,
    private readonly memberWelcomeService: MemberWelcomeService,
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
    this.dependencies.channelSummaryScheduler?.stop();
    this.dependencies.reminderScheduler.stop();
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

      // Required for music features: on failure this rethrows (after
      // triggering shutdown/onFatalError) so the Promise.all below rejects
      // instead of quietly treating a failed Lavalink connection as
      // successful critical initialization.
      const musicInitPromise = this.dependencies.musicPlayerGateway
        .initialize({
          id: readyClient.user.id,
          username: readyClient.user.username,
        })
        .catch((error: unknown) => {
          this.logger.fatal({ error }, "Lavalink initialization failed");
          if (this.onFatalError) {
            this.onFatalError("lavalink-init-failed");
          } else {
            void this.stop("lavalink-init-failed").catch((stopError: unknown) => {
              this.logger.error({ error: stopError }, "Failed to stop application after fatal Lavalink error");
            });
          }
          throw error;
        });

      // Optional/degradable: a failure here is logged but still resolves —
      // non-music commands and chat should still work with a degraded
      // control panel, so this must not fail the Promise.all below.
      const controlPanelInitPromise = (async (): Promise<void> => {
        try {
          await this.dependencies.applicationEmojiCatalog.initialize();
        } catch (error) {
          this.logger.error({ error }, "Application emoji catalog initialization failed");
        }
        try {
          await this.controlChannelService.initialize();
        } catch (error) {
          this.logger.error({ error }, "Control-channel initialization failed — control panel may be degraded");
        }
      })();

      void Promise.all([musicInitPromise, controlPanelInitPromise])
        .then(() => {
          this.ready = true;
          this.logger.info("Critical startup initialization complete; accepting interactions");

          // Started only on successful critical init — starting these
          // unconditionally would let them fire (and even restart) while
          // stop() is tearing persistence down after a fatal Lavalink error.
          this.musicPresenceService.start();
          this.birthdayAnnouncer.start();
          this.dependencies.channelSummaryScheduler?.start();
          this.dependencies.reminderScheduler.start();
        })
        .catch(() => {
          // musicInitPromise already logged fatal and triggered shutdown
          // above — `ready` intentionally stays false so nothing gets
          // dispatched to a handler backed by an uninitialized Lavalink
          // manager while the process is stopping.
        });
    });

    this.client.on(Events.Raw, (payload) => {
      this.dependencies.musicPlayerGateway.acceptDiscordGatewayPayload(payload);
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (
        !this.ready &&
        (interaction.isButton() ||
          interaction.isStringSelectMenu() ||
          interaction.isChatInputCommand() ||
          interaction.isMessageContextMenuCommand())
      ) {
        if (interaction.isRepliable()) {
          void interaction
            .reply({
              content: "I'm still starting up — please try again in a moment.",
              flags: MessageFlags.Ephemeral,
            })
            .catch((error: unknown) => {
              this.logger.error({ error }, "Failed to reply during startup gate");
            });
        }
        return;
      }

      if (interaction.isButton()) {
        void (async (): Promise<void> => {
          if (await this.controlChannelService.handleButton(interaction)) return;
          await this.dependencies.componentDispatcher.dispatch(interaction);
        })().catch((error: unknown) => {
          this.logger.error({ error }, "Button dispatch failed");
        });
        return;
      }

      if (interaction.isStringSelectMenu()) {
        void this.dependencies.componentDispatcher.dispatch(interaction).catch((error: unknown) => {
          this.logger.error({ error }, "Select menu dispatch failed");
        });
        return;
      }

      if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) {
        return;
      }

      void this.dependencies.commandDispatcher.dispatch(interaction).catch((error: unknown) => {
        this.logger.error({ error }, "Interaction dispatch failed");
      });
    });

    this.client.on(Events.MessageCreate, (message) => {
      if (!this.ready) {
        void this.replyStartingUpIfControlChannelMessage(message).catch((error: unknown) => {
          this.logger.error({ error }, "Failed to reply during startup gate");
        });
        return;
      }

      void (async (): Promise<void> => {
        if (await this.controlChannelService.handleMessage(message)) return;
        await this.dependencies.behaviorDispatcher.dispatch(BehaviorEvent.MessageCreated, message);
      })().catch((error: unknown) => {
        this.logger.error({ error }, "Message behavior dispatch failed");
      });
    });

    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const guildId = newState.guild.id;
      if (newState.id === this.client.user?.id) {
        // Invariant-based, not transition-based: check the bot's *current*
        // voice state against the Lavalink player regardless of what
        // oldState.channelId was (it can legitimately be null on a cache
        // miss, which previously let a real disconnect slip past uncleaned).
        void this.dependencies.musicPlayerGateway
          .reconcileVoiceState(guildId)
          .catch((error: unknown) => {
            this.logger.error({ error, guildId }, "Unable to reconcile voice state after update");
          });
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

    this.client.on(Events.GuildMemberAdd, (member) => {
      void this.memberWelcomeService.handleMemberJoin(member).catch((error: unknown) => {
        this.logger.error({ error, guildId: member.guild.id, userId: member.id }, "Unable to process member join");
      });
    });

    this.client.on(Events.GuildMemberRemove, (member) => {
      void this.memberDepartureService.handleMemberLeave(member.guild.id, member.id).catch((error: unknown) => {
        this.logger.error({ error, guildId: member.guild.id, userId: member.id }, "Unable to process member departure");
      });
      void this.memberWelcomeService.handleMemberLeave(member).catch((error: unknown) => {
        this.logger.error({ error, guildId: member.guild.id, userId: member.id }, "Unable to process leave announcement");
      });
    });

    this.client.on(Events.Error, (error) => {
      this.logger.error({ error }, "Discord client error");
    });

    this.client.on(Events.Warn, (message) => {
      this.logger.warn({ message }, "Discord client warning");
    });
  }

  // Mirrors ControlChannelService.handleMessage's own "is this message
  // meant for a music control panel" check — that's what a message typed
  // during startup would otherwise silently fall into (e.g. a play command
  // reaching PlaybackService.enqueue() before Lavalink finishes
  // initializing). Silently dropping such a message would look like the bot
  // ignored the user, so it gets an explicit reply instead. Any other
  // message during startup is dropped without a reply.
  private async replyStartingUpIfControlChannelMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot || message.webhookId) return;
    const profile = this.dependencies.guildConfigurationProvider.find(message.guildId);
    if (!profile?.features.music || profile.channels.controlPanel !== message.channelId) return;
    await message.reply("I'm still starting up — please try again in a moment.");
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
