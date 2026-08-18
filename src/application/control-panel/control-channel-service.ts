import {
  type ActionRowBuilder,
  type ButtonBuilder,
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

import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import type { PlaybackService } from "../music/playback-service.js";
import type { MusicEventBus } from "../music/music-event-bus.js";
import { MusicError } from "../music/music-errors.js";
import type { MusicPlayerGateway, MusicPlayerSnapshot } from "../music/music-player-gateway.js";
import type { ApplicationConfiguration } from "../../config/configuration.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { ControlPanelStateStore } from "./control-panel-state-store.js";
import { renderProgressBar } from "./progress-bar-renderer.js";
import type { ApplicationEmojiCatalog } from "../../infrastructure/discord/application-emoji-catalog.js";
import {
  createQueuedTrackCard,
  failedMusicRequestLifetimeMs,
  queuedTrackCardLifetimeMs,
} from "../../infrastructure/discord/music/queued-track-card.js";
import {
  PanelRefreshCoordinator,
  type PanelRefreshOptions,
} from "./panel-refresh-coordinator.js";
import {
  createMusicPanelControlRows,
  findMusicPanelControl,
  musicPanelControlIdPrefix,
} from "./music-panel-controls.js";

const defaultIdleImageName = "music-idle.png";
const activePlaybackRefreshIntervalMs = 5_000;
const defaultIdleImagePath = resolve("assets/music/no_bg.png");
const upNextPreviewCount = 5;
const upNextTrackTitleMaxChars = 60;

interface ControlPanelPayload {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

export class ControlChannelService {
  private readonly progressRefreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly configuredChannelPermissions = new Set<string>();
  private readonly refreshCoordinator: PanelRefreshCoordinator;
  // Serializes per-guild button actions (so a double-click can't race the same
  // toggle twice) and ensurePanel() calls (so startup init and an event-driven
  // refresh can't both send a fresh panel message for the same guild).
  private readonly guildLocks = new KeyedSerialQueue();

  public constructor(
    private readonly client: Client,
    private readonly applicationConfiguration: ApplicationConfiguration,
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly stateStore: ControlPanelStateStore,
    private readonly playerGateway: MusicPlayerGateway,
    private readonly playbackService: PlaybackService,
    private readonly applicationEmojiCatalog: ApplicationEmojiCatalog,
    private readonly logger: Logger,
    eventBus: MusicEventBus,
  ) {
    this.refreshCoordinator = new PanelRefreshCoordinator(
      async (guildId, options) => this.performPanelRefresh(guildId, options),
    );
    eventBus.subscribe(async (event) => {
      await this.refreshPanel(event.guildId);
    });
  }

  public async initialize(): Promise<void> {
    await this.stateStore.initialize();
    for (const profile of this.guildConfigurationProvider.getAll()) {
      if (profile.features.music && profile.channels.controlPanel) {
        await (async (): Promise<void> => {
          await this.ensureGuildPanel(profile.guildId);
          await this.refreshPanel(profile.guildId);
        })().catch((error: unknown) => {
          this.logger.error(
            { error, guildId: profile.guildId },
            "Unable to initialize music control panel",
          );
        });
      }
    }

  }

  public stop(): void {
    for (const timer of this.progressRefreshTimers.values()) clearTimeout(timer);
    this.progressRefreshTimers.clear();
  }

  // Called when the bot leaves a guild, so its per-guild timer/permission
  // caches don't grow unbounded across many join/leave cycles.
  public handleGuildRemoved(guildId: string): void {
    this.clearProgressRefreshTimer(guildId);
    const profile = this.guildConfigurationProvider.find(guildId);
    if (profile?.channels.controlPanel) {
      this.configuredChannelPermissions.delete(profile.channels.controlPanel);
    }
  }

  public async ensureGuildPanel(guildId: string): Promise<Message> {
    const profile = this.guildConfigurationProvider.require(guildId);
    const message = await this.guildLocks.run(guildId, () => this.ensurePanel(profile));
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

      await statusMessage.edit({
        content: null,
        embeds: [createQueuedTrackCard(result, profile.embedColor as `#${string}`)],
      });
      this.scheduleDeletion(statusMessage, queuedTrackCardLifetimeMs);
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
      this.scheduleDeletion(statusMessage, failedMusicRequestLifetimeMs);
    } finally {
      await this.refreshPanel(message.guildId);
    }

    return true;
  }

  public async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith(musicPanelControlIdPrefix)) {
      return false;
    }

    const control = findMusicPanelControl(interaction.customId);
    if (!control) {
      await interaction.reply({
        content: "This control is no longer supported.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
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

    await interaction.deferUpdate();
    // The interaction owns the next render for this guild. Cancel its pending
    // progress tick now so it cannot race the action; the immediate refresh
    // below will arm a fresh five-second countdown from the updated state.
    this.clearProgressRefreshTimer(interaction.guildId);

    const actor = {
      guildId: interaction.guildId,
      textChannelId: interaction.channelId,
      userId: interaction.user.id,
      member: interaction.member,
    };

    if (control.toggledSnapshotField) {
      const currentSnapshot = this.playerGateway.getSnapshot(interaction.guildId);
      if (currentSnapshot) {
        // Optimistic instant feedback: flip the toggle's color to the
        // predicted next state and disable it immediately, rather than
        // leaving the button looking unresponsive for the duration of the
        // Lavalink round trip. The unconditional refresh below always
        // reconciles with ground truth afterward, so a failed toggle
        // self-corrects on the very next render.
        const predictedSnapshot: MusicPlayerSnapshot = {
          ...currentSnapshot,
          [control.toggledSnapshotField]: !currentSnapshot[control.toggledSnapshotField],
        };
        const pendingRows = createMusicPanelControlRows(profile, predictedSnapshot, control.id);
        await interaction.editReply({ components: pendingRows }).catch(() => undefined);
      }
    }

    try {
      // Serialize per guild so rapid double-clicks (e.g. play/pause, volume)
      // can't both read the same pre-action state and race each other.
      await this.guildLocks.run(interaction.guildId, () => control.execute({
        actor,
        profile,
        playbackService: this.playbackService,
        playerGateway: this.playerGateway,
      }));
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
    options: PanelRefreshOptions = {},
  ): Promise<void> {
    await this.refreshCoordinator.request(guildId, options);
  }

  private async performPanelRefresh(
    guildId: string,
    options: PanelRefreshOptions,
  ): Promise<void> {
    const profile = this.guildConfigurationProvider.find(guildId);
    if (!profile?.channels.controlPanel || !profile.features.music) {
      this.clearProgressRefreshTimer(guildId);
      return;
    }

    try {
      const message = await this.guildLocks.run(guildId, () => this.ensurePanel(profile));
      const snapshot = this.playerGateway.getSnapshot(profile.guildId);
      const payload = this.createPanelPayload(profile, snapshot);
      // Arm the next update from player state, not from the success of the
      // Discord edit. A transient API failure must not permanently stop the
      // panel, and Lavalink may report `playing = false` briefly while a new
      // current track is starting.
      this.resetProgressRefreshTimer(guildId, snapshot);
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

    return {
      content: "Join a voice channel. Members with the music-controller role can queue songs here by name or URL.\n" +
        "-# ♾️ Autoqueue: automatically adds a similar track when the queue runs out.  •  🔁 24/7: keeps the bot connected instead of leaving when idle.",
      embeds: [embed],
      components: createMusicPanelControlRows(profile, snapshot),
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
    const progress = renderProgressBar({
      positionMs: track.positionMs,
      durationMs: track.durationMs,
      paused: snapshot.paused,
      isStream: track.isStream,
      settings: profile.panel.progressBar,
      presetTheme: this.applicationEmojiCatalog.getYohtaTheme(),
      isEmojiAvailable: (emojiId) => this.applicationEmojiCatalog.hasEmoji(emojiId) ||
        this.client.guilds.cache.some((guild) => guild.emojis.cache.has(emojiId)),
    });
    const requester = this.formatRequester(track.requestedByUserId);
    const queueStatus = snapshot.queueLength === 0
      ? "Queue empty"
      : `${snapshot.queueLength} queued`;
    const autoQueueNote = snapshot.autoQueue && snapshot.autoQueueIssue
      ? "  •  ⚠️ Autoqueue found nothing to add"
      : "";
    embed
      .setTitle(snapshot.paused ? "Playback paused" : "Now Playing")
      .setDescription(`### ${title}\n${track.author}\n\n${progress}${requester}`)
      .setFooter({
        text: `🔊 ${snapshot.volume}%  •  ${queueStatus}  •  Loop ${snapshot.repeatMode}${autoQueueNote}`,
      });

    if (snapshot.queueLength > 0) {
      const upNextField = this.createUpNextField(profile.guildId, snapshot.queueLength);
      if (upNextField) embed.addFields(upNextField);
    }

    if (track.artworkUrl) embed.setImage(track.artworkUrl);
    return embed;
  }

  private createUpNextField(
    guildId: string,
    queueLength: number,
  ): { name: string; value: string } | null {
    const upcoming = this.playerGateway.getQueue(guildId).slice(0, upNextPreviewCount);
    if (upcoming.length === 0) return null;

    const lines = upcoming.map((track, index) => {
      const label = this.truncateTrackTitle(track.title);
      return `${index + 1}. ${track.uri ? `[${label}](${track.uri})` : label}`;
    });
    const remaining = queueLength - upcoming.length;
    if (remaining > 0) lines.push(`…and ${remaining} more`);
    return { name: "Up next", value: lines.join("\n").slice(0, 1_024) };
  }

  private truncateTrackTitle(title: string): string {
    const sanitized = title.replaceAll("[", "").replaceAll("]", "");
    return sanitized.length > upNextTrackTitleMaxChars
      ? `${sanitized.slice(0, upNextTrackTitleMaxChars - 1)}…`
      : sanitized;
  }

  private formatRequester(requestedByUserId: string | null): string {
    if (!requestedByUserId) return "";
    if (requestedByUserId !== "autoqueue") {
      return `\nRequested by <@${requestedByUserId}>`;
    }

    const botUserId = this.client.user?.id;
    return botUserId
      ? `\nRequested by <@${botUserId}> (Autoqueue)`
      : "\nRequested by Autoqueue";
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

  private scheduleDeletion(message: Message, delayMs = failedMusicRequestLifetimeMs): void {
    setTimeout(() => {
      void message.delete().catch(() => undefined);
    }, delayMs).unref();
  }

  private resetProgressRefreshTimer(
    guildId: string,
    snapshot: MusicPlayerSnapshot | null,
  ): void {
    this.clearProgressRefreshTimer(guildId);
    if (!snapshot?.currentTrack || snapshot.paused) return;

    const timer = setTimeout(() => {
      this.progressRefreshTimers.delete(guildId);
      void this.refreshPanel(guildId);
    }, activePlaybackRefreshIntervalMs);
    timer.unref();
    this.progressRefreshTimers.set(guildId, timer);
  }

  private clearProgressRefreshTimer(guildId: string): void {
    const timer = this.progressRefreshTimers.get(guildId);
    if (timer) clearTimeout(timer);
    this.progressRefreshTimers.delete(guildId);
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
