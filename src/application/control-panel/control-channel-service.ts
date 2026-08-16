import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
} from "discord.js";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Logger } from "pino";

import type { PlaybackService } from "../music/playback-service.js";
import type { MusicEventBus } from "../music/music-event-bus.js";
import { MusicError, MusicPlayerNotFoundError } from "../music/music-errors.js";
import type { MusicPlayerGateway, MusicPlayerSnapshot } from "../music/music-player-gateway.js";
import type { ApplicationConfiguration } from "../../config/configuration.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { ControlPanelStateStore } from "./control-panel-state-store.js";

const controlIdPrefix = "music-panel:v1:";
const defaultIdleImageName = "music-idle.png";
const defaultIdleImagePath = resolve("assets/music/no_bg.png");

interface ControlPanelPayload {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

export class ControlChannelService {
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly configuredChannelPermissions = new Set<string>();

  public constructor(
    private readonly client: Client,
    private readonly applicationConfiguration: ApplicationConfiguration,
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly stateStore: ControlPanelStateStore,
    private readonly playerGateway: MusicPlayerGateway,
    private readonly playbackService: PlaybackService,
    private readonly logger: Logger,
    eventBus: MusicEventBus,
  ) {
    eventBus.subscribe(async (event) => {
      await this.refreshPanel(event.guildId);
    });
  }

  public async initialize(): Promise<void> {
    await this.stateStore.initialize();
    for (const profile of this.guildConfigurationProvider.getAll()) {
      if (profile.features.music && profile.channels.controlPanel) {
        await this.ensureGuildPanel(profile.guildId).catch((error: unknown) => {
          this.logger.error(
            { error, guildId: profile.guildId },
            "Unable to initialize music control panel",
          );
        });
      }
    }

    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.refreshConfiguredPanels();
      }, 15_000);
      this.refreshTimer.unref();
    }
  }

  public stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  public async ensureGuildPanel(guildId: string): Promise<Message> {
    const profile = this.guildConfigurationProvider.require(guildId);
    const message = await this.ensurePanel(profile);
    if (!message.pinned) {
      await message.pin("Persistent music control panel").catch((error: unknown) => {
        this.logger.warn({ error, guildId }, "Unable to pin music control panel");
      });
    }
    return message;
  }

  public async handleMessage(message: Message): Promise<boolean> {
    if (!message.inGuild() || message.author.bot || message.webhookId) {
      return false;
    }

    const profile = this.guildConfigurationProvider.find(message.guildId);
    if (
      !profile?.features.music ||
      profile.channels.controlPanel !== message.channelId
    ) {
      return false;
    }

    const botId = this.client.user?.id;
    if (profile.features.chatbot && botId && message.mentions.users.has(botId)) {
      return false;
    }

    const query = this.normalizeSongQuery(message);
    if (query.length === 0) {
      await message.delete().catch(() => undefined);
      return true;
    }

    if (
      !message.member ||
      !this.canControl(message.member, message.author.id, profile)
    ) {
      const denied = await message.reply(
        "You need a music-controller role to request songs.",
      );
      this.scheduleDeletion(denied);
      await message.delete().catch(() => undefined);
      return true;
    }

    const statusMessage = await message.reply("Searching…");

    this.scheduleDeletion(statusMessage);
    await message.delete().catch(() => undefined);

    try {
      const result = await this.playbackService.enqueue(
        {
          guildId: message.guildId,
          textChannelId: message.channelId,
          userId: message.author.id,
          member: message.member,
        },
        query,
      );

      await statusMessage.edit(
        result.addedTrackCount > 1
          ? `Added ${result.addedTrackCount} tracks from the playlist.`
          : `Added **${result.firstTrack.title}** to the queue.`,
      );
    } catch (error) {
      this.logger.warn(
        { error, guildId: message.guildId, userId: message.author.id },
        "Control-channel request failed",
      );
      await statusMessage.edit(
        error instanceof MusicError
          ? error.message
          : "The request could not be completed.",
      );
    } finally {
      await this.refreshPanel(message.guildId);
    }

    return true;
  }

  public async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith(controlIdPrefix)) {
      return false;
    }

    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: "This control is only available in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const profile = this.guildConfigurationProvider.find(interaction.guildId);
    const panelState = this.stateStore.find(interaction.guildId);
    if (
      !panelState ||
      panelState.channelId !== interaction.channelId ||
      panelState.messageId !== interaction.message.id
    ) {
      await interaction.reply({
        content: "This control panel is obsolete. Use the current panel message.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (!profile || !this.canControl(interaction.member, interaction.user.id, profile)) {
      await interaction.reply({
        content: "You need a music-controller role to use this control.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const action = interaction.customId.slice(controlIdPrefix.length);
    const actor = {
      guildId: interaction.guildId,
      textChannelId: interaction.channelId,
      userId: interaction.user.id,
      member: interaction.member,
    };

    try {
      switch (action) {
        case "previous":
          await this.playbackService.previous(actor);
          break;
        case "play-pause":
          if (!this.playerGateway.hasPlayer(interaction.guildId)) {
            throw new MusicPlayerNotFoundError();
          }
          if (this.playerGateway.isPaused(interaction.guildId)) {
            await this.playbackService.resume(actor);
          } else {
            await this.playbackService.pause(actor);
          }
          break;
        case "skip":
          await this.playbackService.skip(actor);
          break;
        case "volume-down":
          await this.playbackService.changeVolume(
            actor,
            -profile.music.volumeButtonStep,
            profile.music.maximumVolume,
          );
          break;
        case "volume-up":
          await this.playbackService.changeVolume(
            actor,
            profile.music.volumeButtonStep,
            profile.music.maximumVolume,
          );
          break;
        case "shuffle":
          await this.playbackService.shuffle(actor);
          break;
        case "autoqueue": {
          const enabled = await this.playbackService.toggleAutoQueue(actor);
          await interaction.reply({
            content: `Autoqueue ${enabled ? "enabled" : "disabled"}.`,
            flags: MessageFlags.Ephemeral,
          });
          await this.refreshPanel(interaction.guildId);
          return true;
        }
        case "24-7": {
          const enabled = await this.playbackService.toggleTwentyFourSeven(actor);
          await interaction.reply({
            content: `24/7 mode ${enabled ? "enabled" : "disabled"}.`,
            flags: MessageFlags.Ephemeral,
          });
          await this.refreshPanel(interaction.guildId);
          return true;
        }
        case "stop":
          await this.playbackService.stop(actor);
          break;
        default:
          await interaction.reply({
            content: "This control is no longer supported.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
      }

      await this.replyEphemeral(interaction, "Music control applied.");
    } catch (error) {
      await this.replyEphemeral(
        interaction,
        error instanceof MusicError ? error.message : "The control failed.",
      );
    }

    await this.refreshPanel(interaction.guildId);
    return true;
  }

  public async refreshPanel(
    guildId: string,
    options: { forceIdleImage?: boolean } = {},
  ): Promise<void> {
    const profile = this.guildConfigurationProvider.find(guildId);
    if (!profile?.channels.controlPanel || !profile.features.music) return;

    try {
      const message = await this.ensurePanel(profile);
      const snapshot = this.playerGateway.getSnapshot(profile.guildId);
      const payload = this.createPanelPayload(profile, snapshot);
      await message.edit(this.createPanelEditOptions(message, profile, snapshot, payload, options));
    } catch (error) {
      this.logger.error({ error, guildId }, "Unable to refresh music control panel");
    }
  }

  private async ensurePanel(profile: GuildConfiguration): Promise<Message> {
    const channelId = profile.channels.controlPanel;
    if (!channelId) throw new Error("Control panel channel is not configured.");

    const guild = this.client.guilds.cache.get(profile.guildId);
    if (!guild) throw new Error(`The bot is not connected to guild "${profile.guildId}".`);

    const channel = await guild.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Control panel channel "${channelId}" is not a guild text channel.`);
    }

    await this.ensureChannelPermissions(channel, guild);

    const state = this.stateStore.find(profile.guildId);
    if (state?.channelId === channelId) {
      const existing = await channel.messages.fetch(state.messageId).catch(() => null);
      if (existing && existing.author.id === this.client.user?.id) {
        return existing;
      }
    }

    const snapshot = this.playerGateway.getSnapshot(profile.guildId);
    const payload = this.createPanelPayload(profile, snapshot);
    const needsIdleAttachment = !profile.idleImageUrl && !snapshot?.currentTrack;
    const created = await channel.send(
      needsIdleAttachment
        ? { ...payload, files: [this.getIdleImageFile(profile)] }
        : payload,
    );
    await this.stateStore.save({
      guildId: profile.guildId,
      channelId,
      messageId: created.id,
    });
    if (state && (state.channelId !== channelId || state.messageId !== created.id)) {
      await this.deleteObsoletePanel(profile.guildId, state.channelId, state.messageId);
    }
    return created;
  }

  private normalizeSongQuery(message: Message<true>): string {
    const botId = this.client.user?.id;
    const withoutMentions = botId
      ? message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "")
      : message.content;
    return withoutMentions.trim();
  }

  private async ensureChannelPermissions(channel: TextChannel, guild: Guild): Promise<void> {
    if (this.configuredChannelPermissions.has(channel.id)) return;

    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { UseApplicationCommands: false },
      { reason: "Reserve the music control channel for panel controls and song requests" },
    );
    this.configuredChannelPermissions.add(channel.id);
  }

  private createPanelEditOptions(
    message: Message,
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
    payload: ControlPanelPayload,
    options: { forceIdleImage?: boolean } = {},
  ): ControlPanelPayload & {
    attachments?: [];
    files?: Array<{ attachment: string; name: string }>;
  } {
    const needsIdleImage = !profile.idleImageUrl && !snapshot?.currentTrack;
    const idleImageName = this.getIdleImageName(profile);
    const hasIdleAttachment = message.attachments.some((attachment) => attachment.name === idleImageName);

    if (!needsIdleImage) return { ...payload, attachments: [] };
    if (!hasIdleAttachment || options.forceIdleImage) {
      return { ...payload, attachments: [], files: [this.getIdleImageFile(profile)] };
    }

    // Omitting `attachments` preserves the existing idle image. Sending an
    // empty array removes it and makes the next refresh upload it again.
    return payload;
  }

  private async replyEphemeral(interaction: ButtonInteraction, content: string): Promise<void> {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  private async deleteObsoletePanel(
    guildId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    const oldChannel = await guild?.channels.fetch(channelId).catch(() => null);
    if (!oldChannel?.isTextBased() || oldChannel.isDMBased()) return;
    const oldMessage = await oldChannel.messages.fetch(messageId).catch(() => null);
    if (!oldMessage || oldMessage.author.id !== this.client.user?.id) return;
    await oldMessage.delete().catch((error: unknown) => {
      this.logger.warn(
        { error, guildId, channelId, messageId },
        "Unable to delete obsolete music control panel",
      );
    });
  }

  private createPanelPayload(
    profile: GuildConfiguration,
    snapshot = this.playerGateway.getSnapshot(profile.guildId),
  ): ControlPanelPayload {
    const embed = this.createPanelEmbed(profile, snapshot);
    const paused = snapshot?.paused ?? false;

    const primaryControls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${controlIdPrefix}previous`)
        .setEmoji("⏮️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!snapshot || snapshot.previousTrackCount === 0),
      new ButtonBuilder()
        .setCustomId(`${controlIdPrefix}play-pause`)
        .setEmoji(paused ? "▶️" : "⏯️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!snapshot),
      new ButtonBuilder()
        .setCustomId(`${controlIdPrefix}stop`)
        .setEmoji("⏹️")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!snapshot),
      new ButtonBuilder()
        .setCustomId(`${controlIdPrefix}skip`)
        .setEmoji("⏭️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!snapshot),
    );

    const secondaryControls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${controlIdPrefix}volume-down`)
        .setEmoji("🔉")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!snapshot || snapshot.volume <= 0),
      new ButtonBuilder()
        .setCustomId(`${controlIdPrefix}volume-up`)
        .setEmoji("🔊")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!snapshot || snapshot.volume >= profile.music.maximumVolume),
      new ButtonBuilder()
        .setCustomId(`${controlIdPrefix}autoqueue`)
        .setEmoji("♾️")
        .setStyle(snapshot?.autoQueue ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!snapshot),
      new ButtonBuilder()
        .setCustomId(`${controlIdPrefix}24-7`)
        .setLabel("24/7")
        .setEmoji("🔁")
        .setStyle(snapshot?.twentyFourSeven ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!snapshot),
      new ButtonBuilder()
        .setCustomId(`${controlIdPrefix}shuffle`)
        .setEmoji("🔀")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!snapshot || snapshot.queueLength < 2),
    );

    return {
      content: "Join a voice channel. Members with the music-controller role can queue songs here by name or URL.",
      embeds: [embed],
      components: [primaryControls, secondaryControls],
    };
  }

  private createPanelEmbed(
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
  ): EmbedBuilder {
    const embed = new EmbedBuilder().setColor(profile.embedColor as `#${string}`);
    if (!snapshot?.currentTrack) {
      embed
        .setTitle("No song currently playing")
        .setDescription("The player is ready for a new request.");
      embed.setImage(profile.idleImageUrl ?? `attachment://${this.getIdleImageName(profile)}`);
      return embed;
    }

    const track = snapshot.currentTrack;
    const title = track.uri ? `[${track.title}](${track.uri})` : track.title;
    embed
      .setTitle(snapshot.paused ? "Playback paused" : "Now Playing")
      .setDescription(title)
      .addFields(
        { name: "Artist", value: track.author, inline: true },
        { name: "Volume", value: `${snapshot.volume}%`, inline: true },
        { name: "Queued", value: String(snapshot.queueLength), inline: true },
        { name: "Loop", value: snapshot.repeatMode, inline: true },
        { name: "Autoqueue", value: snapshot.autoQueue ? "On" : "Off", inline: true },
        { name: "24/7", value: snapshot.twentyFourSeven ? "On" : "Off", inline: true },
        {
          name: "Progress",
          value: `${this.formatDuration(track.positionMs)} / ${this.formatDuration(track.durationMs)}`,
          inline: false,
        },
      );

    if (track.requestedByUserId) {
      embed.addFields({
        name: "Requested by",
        value: `<@${track.requestedByUserId}>`,
        inline: true,
      });
    }
    if (track.artworkUrl) embed.setImage(track.artworkUrl);
    return embed;
  }

  private hasRestrictedRole(
    member: GuildMember | null,
    profile: GuildConfiguration,
  ): boolean {
    return Boolean(
      member &&
        [...profile.roles.restricted].some((roleId) => member.roles.cache.has(roleId)),
    );
  }

  private canControl(
    member: GuildMember,
    userId: string,
    profile: GuildConfiguration,
  ): boolean {
    const isOwner = this.applicationConfiguration.ownerUserIds.has(userId);
    if (this.hasRestrictedRole(member, profile) && !isOwner) return false;
    if (isOwner) return true;

    const allowedRoles = new Set([
      ...profile.roles.musicController,
      ...profile.roles.botAdministrator,
    ]);
    return [...allowedRoles].some((roleId) => member.roles.cache.has(roleId));
  }

  private scheduleDeletion(message: Message): void {
    setTimeout(() => {
      void message.delete().catch(() => undefined);
    }, 15_000);
  }

  private async refreshConfiguredPanels(): Promise<void> {
    const guildIds = this.guildConfigurationProvider
      .getAll()
      .filter((profile) => profile.features.music && profile.channels.controlPanel)
      .map((profile) => profile.guildId);

    await Promise.all(guildIds.map((guildId) => this.refreshPanel(guildId)));
  }

  private formatDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  private getDefaultIdleImageFile(): { attachment: string; name: string } {
    if (!existsSync(defaultIdleImagePath)) {
      throw new Error(`Default music idle image is missing: ${defaultIdleImagePath}`);
    }
    return { attachment: defaultIdleImagePath, name: defaultIdleImageName };
  }

  private getIdleImageName(profile: GuildConfiguration): string {
    if (!profile.idleImageAsset) return defaultIdleImageName;
    const path = resolve(this.applicationConfiguration.runtimeDataDirectory, profile.idleImageAsset);
    return existsSync(path) ? `music-idle${extname(profile.idleImageAsset)}` : defaultIdleImageName;
  }

  private getIdleImageFile(profile: GuildConfiguration): { attachment: string; name: string } {
    if (!profile.idleImageAsset) return this.getDefaultIdleImageFile();
    const path = resolve(this.applicationConfiguration.runtimeDataDirectory, profile.idleImageAsset);
    if (!existsSync(path)) {
      this.logger.warn({ guildId: profile.guildId, path }, "Configured idle image asset is missing; using default");
      return this.getDefaultIdleImageFile();
    }
    return { attachment: path, name: this.getIdleImageName(profile) };
  }
}
