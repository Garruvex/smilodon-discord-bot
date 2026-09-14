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
import { isDeepStrictEqual } from "node:util";
import type { Logger } from "pino";

import { hasMusicDjPrivilege } from "../access/access-rules.js";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import type { PlaybackService } from "../music/playback-service.js";
import type { MusicEventBus } from "../music/music-event-bus.js";
import { MusicError } from "../music/music-errors.js";
import type { MusicPlayerGateway, MusicPlayerSnapshot } from "../music/music-player-gateway.js";
import type { MusicTrack } from "../../domain/music/music-track.js";
import type { ApplicationConfiguration } from "../../config/configuration.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type {
  ControlPanelRuntimeState,
  ControlPanelStateStore,
} from "./control-panel-state-store.js";
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
const upNextTrackTitleMaxChars = 60;
// Leaves headroom under the embed description's 4096-char hard cap for the
// header line and the "…and N more" note appended after this budget runs out.
const queueListCharBudget = 3_500;

interface ControlPanelPayload {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

// The three messages that make up one guild's panel, top to bottom.
interface PanelMessageTrio {
  nowPlaying: Message;
  lyrics: Message;
  queue: Message;
}

function formatQueueDuration(totalMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join("");
}

export class ControlChannelService {
  private readonly progressRefreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly configuredChannelPermissions = new Set<string>();
  private readonly refreshCoordinator: PanelRefreshCoordinator;
  // The action queue: serializes per-guild playbackService/playerGateway
  // mutations (button clicks, voice-state reconciliation) so a double-click
  // can't race the same toggle twice, and so a queued second click always
  // captures/predicts from the first click's *actual* post-execution state
  // rather than a snapshot read before either ran.
  private readonly guildLocks = new KeyedSerialQueue();
  // The write queue: serializes every actual Discord write to the panel's
  // three messages per guild — both the button handler's optimistic edit and
  // the authoritative ensurePanelMessages()/message.edit() render, regardless
  // of which path triggered it (a click, a background event, the progress
  // timer, or ensureGuildPanel()). Without this, an optimistic edit and an
  // in-flight authoritative edit can complete out of order over the network,
  // making an older render visually stomp a newer one.
  private readonly panelWriteQueue = new KeyedSerialQueue();
  private readonly unsubscribeEventBus: () => void;
  private stopped = false;

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
    this.unsubscribeEventBus = eventBus.subscribe(async (event) => {
      if (this.stopped) return;
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
    this.stopped = true;
    this.unsubscribeEventBus();
    this.refreshCoordinator.stop();
    for (const timer of this.progressRefreshTimers.values()) clearTimeout(timer);
    this.progressRefreshTimers.clear();
  }

  // Called when the bot leaves a guild, so its per-guild timer/permission
  // caches don't grow unbounded across many join/leave cycles.
  public handleGuildRemoved(guildId: string): void {
    this.clearProgressRefreshTimer(guildId);
    this.refreshCoordinator.stopGuild(guildId);
    const profile = this.guildConfigurationProvider.find(guildId);
    if (profile?.channels.controlPanel) {
      this.configuredChannelPermissions.delete(profile.channels.controlPanel);
    }
  }

  public async ensureGuildPanel(guildId: string): Promise<Message> {
    const profile = this.guildConfigurationProvider.require(guildId);
    const messages = await this.panelWriteQueue.run(guildId, () => this.ensurePanelMessages(profile));
    if (!messages.nowPlaying.pinned) {
      await messages.nowPlaying.pin("Persistent music control panel").catch((error: unknown) => {
        this.logger.warn({ error, guildId }, "Unable to pin music control panel");
      });
    }
    return messages.nowPlaying;
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

    if (!message.member) {
      await message.delete().catch(() => undefined);
      return true;
    }

    if (!this.canRequestSongs(message.member, message.author.id, profile)) {
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
          voiceChannelId: message.member.voice.channelId,
          bypassVoiceChannelCheck: hasMusicDjPrivilege(new Set(message.member.roles.cache.keys()), profile),
          allowQueueWithoutVoiceChannel: profile.music.openQueueRequestsEnabled,
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
    // The stateStore match alone isn't enough to prove this panel is still
    // current: it's only ever overwritten when ensurePanelMessages() creates
    // a replacement (see ensurePanelMessages), never cleared when an admin
    // disables the music feature or reassigns channels.controlPanel to
    // somewhere else without a replacement panel being created there.
    // Re-checking against the live guild configuration here closes that gap
    // — a panel left behind by a config change stops being authorized even
    // though stateStore still (harmlessly, until now) points at it. Buttons
    // only ever live on the queue message, so that's the one to compare.
    if (
      !profile ||
      !profile.features.music ||
      profile.channels.controlPanel !== interaction.channelId ||
      !panelState ||
      panelState.channelId !== interaction.channelId ||
      panelState.queueMessageId !== interaction.message.id
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

    // Fast path: when nothing is already queued for this guild, combine
    // "acknowledge the interaction" and "show the predicted pending state"
    // into one interaction.update() call instead of deferUpdate() followed by
    // a separate editReply() — that second round trip is otherwise pure
    // added latency before the button visibly reacts at all. Requires both
    // queues to be idle: guildLocks because update() has the same 3-second
    // window as deferUpdate() (no time to wait behind a queued action), and
    // panelWriteQueue because update() edits the same message outside that
    // queue's ordering guarantee — with a background write in flight, this
    // edit could land out of order and get stomped by an older render (see
    // panelWriteQueue's field comment).
    const usesPendingState = control.showPendingState !== false;
    let shownPendingViaFastAck = false;
    if (
      usesPendingState &&
      !this.guildLocks.isBusy(interaction.guildId) &&
      !this.panelWriteQueue.isBusy(interaction.guildId)
    ) {
      const currentSnapshot = this.playerGateway.getSnapshot(interaction.guildId);
      const predictedSnapshot = currentSnapshot && control.predictSnapshot
        ? control.predictSnapshot(currentSnapshot)
        : currentSnapshot;
      const pendingRows = createMusicPanelControlRows(profile, predictedSnapshot, control.id);
      try {
        // Still routed through panelWriteQueue even though we just checked
        // it's idle — that check only proves nothing is in flight *now*, not
        // that nothing gets submitted during this call's own await. Queueing
        // it keeps any such write waiting its turn behind this one instead of
        // racing it.
        await this.panelWriteQueue.run(interaction.guildId, () =>
          interaction.update({ components: pendingRows }));
        shownPendingViaFastAck = true;
      } catch {
        // Fall through to the slow path — deferUpdate() below will surface
        // the same failure (e.g. an already-expired interaction) the same way.
      }
    }
    if (!shownPendingViaFastAck) {
      await interaction.deferUpdate();
    }
    // The interaction owns the next render for this guild. Cancel its pending
    // progress tick now so it cannot race the action; the immediate refresh
    // below will arm a fresh five-second countdown from the updated state.
    this.clearProgressRefreshTimer(interaction.guildId);

    const actor = {
      guildId: interaction.guildId,
      textChannelId: interaction.channelId,
      userId: interaction.user.id,
      voiceChannelId: interaction.member.voice.channelId,
      bypassVoiceChannelCheck: hasMusicDjPrivilege(new Set(interaction.member.roles.cache.keys()), profile),
      // Panel buttons only ever control an existing player (pause/skip/etc.);
      // open queue requests never applies to them.
      allowQueueWithoutVoiceChannel: false,
    };

    let staleRecovered = false;
    let executionError: unknown;
    // The whole capture → predict → optimistic-write → execute → authoritative
    // write pipeline runs as one action-queue turn. That's what makes the
    // prediction correct (a queued second click reads state *after* this
    // click's execute() actually ran, not a snapshot taken before either
    // ran) and what makes the write ordering correct (this click's
    // authoritative write is fully submitted to the write queue before a
    // queued second click's own optimistic write can be submitted, so a
    // newer render can never be stomped by an older one arriving late).
    await this.guildLocks.run(interaction.guildId, async () => {
      // The bot's actual Discord voice connection is authoritative over
      // whatever channel the Lavalink player still thinks it's in. A
      // mismatch (kick, channel deletion, a missed VoiceStateUpdate) means
      // the player is stale — destroy it now rather than let
      // channel-mismatch checks (e.g. 24/7's assertControllablePlayer)
      // permanently block every control, including the one that would have
      // turned the stale session off.
      staleRecovered = await this.playerGateway.reconcileVoiceState(interaction.guildId);
      try {
        if (!staleRecovered) {
          // Optimistic instant feedback: render the predicted post-action
          // state (or, for controls without a predictor, just the clicked
          // button disabled) immediately, rather than leaving the panel
          // looking unresponsive for the duration of the Lavalink round
          // trip. The authoritative write below always reconciles with
          // ground truth afterward, so a failed/incorrect prediction
          // self-corrects immediately. Controls whose result is already a
          // local, instant toggle (24/7, autoqueue) skip this phase
          // entirely and go straight to the authoritative color — there's
          // no round trip worth masking, so a disabled flash would only be
          // visual noise.
          if (control.showPendingState !== false && !shownPendingViaFastAck) {
            const currentSnapshot = this.playerGateway.getSnapshot(interaction.guildId);
            const predictedSnapshot = currentSnapshot && control.predictSnapshot
              ? control.predictSnapshot(currentSnapshot)
              : currentSnapshot;
            // Components only: the embeds (track title/art/idle image,
            // lyrics, queue list) depend on attachment/data bookkeeping
            // handled by the authoritative write below, so predicting them
            // here risks a broken image reference or stale queue text.
            // Buttons are self-contained and safe to predict.
            const pendingRows = createMusicPanelControlRows(profile, predictedSnapshot, control.id);
            await this.panelWriteQueue.run(interaction.guildId, () =>
              interaction.editReply({ components: pendingRows }).catch(() => undefined));
          }
          await control.execute({
            actor,
            profile,
            playbackService: this.playbackService,
            playerGateway: this.playerGateway,
          });
        }
      } catch (error) {
        executionError = error;
      } finally {
        // Always reconcile the panel with ground truth, success or failure,
        // so a failed action (or a failed ephemeral reply right after it)
        // can never leave the optimistic prediction stuck on screen. This
        // bypasses the background debounce scheduler entirely — user
        // interaction feedback goes straight into the write queue with
        // immediate priority — but still funnels through the *same* queue
        // as background/event-driven writes, so it can't race them either.
        await this.writePanel(interaction.guildId, profile, {});
      }
    });

    if (staleRecovered) {
      await this.replyEphemeral(
        interaction,
        "The bot's voice connection was out of sync with the player, so the session was reset.",
      );
    } else if (executionError) {
      await this.replyEphemeral(
        interaction,
        executionError instanceof MusicError ? executionError.message : "The control failed.",
      );
    }

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

    // Self-healing fallback: catches a stale player left behind by a missed
    // VoiceStateUpdate (see reconcileVoiceState) even when no button click
    // triggers the check first. Goes through the action queue since it
    // mutates playerGateway state; not needed when called from handleButton,
    // which already reconciles under its own action-queue turn before
    // reaching writePanel directly.
    await this.guildLocks.run(guildId, () => this.playerGateway.reconcileVoiceState(guildId));
    await this.writePanel(guildId, profile, options);
  }

  // The single choke point for every actual Discord write to the panel's
  // three messages — see panelWriteQueue's field comment for why this can't
  // be skipped for any caller, optimistic or authoritative. Each message is
  // independently skip-checked, so an unchanged message (e.g. lyrics didn't
  // move this tick) costs zero extra API calls.
  private async writePanel(
    guildId: string,
    profile: GuildConfiguration,
    options: PanelRefreshOptions,
  ): Promise<void> {
    await this.panelWriteQueue.run(guildId, async () => {
      try {
        const messages = await this.ensurePanelMessages(profile);
        const snapshot = this.playerGateway.getSnapshot(profile.guildId);
        // Arm the next update from player state, not from the success of the
        // Discord edit. A transient API failure must not permanently stop the
        // panel, and Lavalink may report `playing = false` briefly while a new
        // current track is starting.
        this.resetProgressRefreshTimer(guildId, snapshot);

        const nowPlayingPayload = this.createNowPlayingPayload(profile, snapshot);
        const nowPlayingEditOptions = this.createNowPlayingEditOptions(
          messages.nowPlaying,
          profile,
          snapshot,
          nowPlayingPayload,
          options,
        );
        if (!this.matchesCurrentMessage(messages.nowPlaying, nowPlayingEditOptions)) {
          await messages.nowPlaying.edit(nowPlayingEditOptions);
        }

        const lyricsPayload = this.createLyricsPayload(profile, snapshot);
        if (!this.matchesCurrentMessage(messages.lyrics, lyricsPayload)) {
          await messages.lyrics.edit(lyricsPayload);
        }

        const queuePayload = this.createQueueControlsPayload(profile, snapshot);
        if (!this.matchesCurrentMessage(messages.queue, queuePayload)) {
          await messages.queue.edit(queuePayload);
        }
      } catch (error) {
        this.logger.error({ error, guildId }, "Unable to refresh music control panel");
      }
    });
  }

  private async ensurePanelMessages(profile: GuildConfiguration): Promise<PanelMessageTrio> {
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
      const existing = await this.fetchExistingTrio(channel, state);
      if (existing) return existing;
      // Same channel, but the trio is broken (one message deleted, or a
      // legacy pre-split single-message row) — clean up whatever survives
      // here. No permission change: this channel stays the panel channel.
      await this.deleteTrioMessagesBestEffort(channel, state);
    } else if (state) {
      // The panel moved to a different channel — tear down the old one,
      // including reverting its reserved-for-panel permission overwrite.
      await this.deleteObsoletePanelTrio(profile.guildId, state);
    }

    const snapshot = this.playerGateway.getSnapshot(profile.guildId);
    // Created in this fixed order (top to bottom) and only ever edited in
    // place afterward, so they stay adjacent regardless of what else gets
    // posted in the channel later — see the trio-recovery paths above for
    // the only case that reorders them (and even then, always recreated
    // together in this same order).
    const nowPlaying = await this.sendNowPlayingMessage(channel, profile, snapshot);
    const lyrics = await channel.send(this.createLyricsPayload(profile, snapshot));
    const queue = await channel.send(this.createQueueControlsPayload(profile, snapshot));

    await this.stateStore.save({
      guildId: profile.guildId,
      channelId,
      nowPlayingMessageId: nowPlaying.id,
      lyricsMessageId: lyrics.id,
      queueMessageId: queue.id,
    });

    return { nowPlaying, lyrics, queue };
  }

  private async fetchExistingTrio(
    channel: TextChannel,
    state: ControlPanelRuntimeState,
  ): Promise<PanelMessageTrio | null> {
    if (!state.nowPlayingMessageId || !state.lyricsMessageId || !state.queueMessageId) return null;

    const [nowPlaying, lyrics, queue] = await Promise.all([
      channel.messages.fetch(state.nowPlayingMessageId).catch(() => null),
      channel.messages.fetch(state.lyricsMessageId).catch(() => null),
      channel.messages.fetch(state.queueMessageId).catch(() => null),
    ]);
    const botId = this.client.user?.id;
    if (
      nowPlaying && lyrics && queue &&
      nowPlaying.author.id === botId && lyrics.author.id === botId && queue.author.id === botId
    ) {
      return { nowPlaying, lyrics, queue };
    }
    return null;
  }

  private async deleteTrioMessagesBestEffort(
    channel: TextChannel,
    state: ControlPanelRuntimeState,
  ): Promise<void> {
    for (const messageId of [state.nowPlayingMessageId, state.lyricsMessageId, state.queueMessageId]) {
      if (messageId) await this.deleteIfOwnedByBot(channel, messageId);
    }
  }

  private async deleteIfOwnedByBot(
    channel: { messages: { fetch: (id: string) => Promise<Message> } },
    messageId: string,
  ): Promise<void> {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message && message.author.id === this.client.user?.id) {
      await message.delete().catch(() => undefined);
    }
  }

  private async sendNowPlayingMessage(
    channel: TextChannel,
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
  ): Promise<Message> {
    const payload = this.createNowPlayingPayload(profile, snapshot);
    const needsIdleAttachment = !profile.idleImageUrl && !snapshot?.currentTrack;
    return channel.send(
      needsIdleAttachment ? { ...payload, files: [this.getIdleImageFile(profile)] } : payload,
    );
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

  private createNowPlayingEditOptions(
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

  // `attachments: []` shows up on every edit while a track is playing (see
  // above) even when nothing about the attachments actually needs to
  // change, so its mere presence can't gate the skip — only compare it
  // against whether the message actually has an attachment to clear.
  private matchesCurrentMessage(
    message: Message,
    editOptions: ControlPanelPayload & {
      attachments?: [];
      files?: Array<{ attachment: string; name: string }>;
    },
  ): boolean {
    if (editOptions.files) return false;
    if (editOptions.attachments && message.attachments.size > 0) return false;
    if (editOptions.content !== message.content) return false;

    const newEmbed = editOptions.embeds[0];
    const currentEmbed = message.embeds[0];
    const embedsMatch = newEmbed
      ? currentEmbed !== undefined && isDeepStrictEqual(newEmbed.toJSON(), currentEmbed.toJSON())
      : currentEmbed === undefined;
    if (!embedsMatch) return false;

    const newComponents = editOptions.components.map((row) => row.toJSON());
    const currentComponents = message.components.map((row) => row.toJSON());
    return isDeepStrictEqual(newComponents, currentComponents);
  }

  private async replyEphemeral(interaction: ButtonInteraction, content: string): Promise<void> {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  private async deleteObsoletePanelTrio(
    guildId: string,
    state: ControlPanelRuntimeState,
  ): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    const oldChannel = await guild?.channels.fetch(state.channelId).catch(() => null);
    if (!oldChannel?.isTextBased() || oldChannel.isDMBased()) return;

    if (guild && oldChannel.type === ChannelType.GuildText) {
      await this.restoreChannelPermissions(oldChannel, guild);
    }

    for (const messageId of [state.nowPlayingMessageId, state.lyricsMessageId, state.queueMessageId]) {
      if (!messageId) continue;
      const oldMessage = await oldChannel.messages.fetch(messageId).catch(() => null);
      if (!oldMessage || oldMessage.author.id !== this.client.user?.id) continue;
      await oldMessage.delete().catch((error: unknown) => {
        this.logger.warn(
          { error, guildId, channelId: state.channelId, messageId },
          "Unable to delete obsolete music control panel message",
        );
      });
    }
  }

  // Reverses ensureChannelPermissions(): resets the UseApplicationCommands
  // overwrite back to inherited rather than deleting the whole @everyone
  // overwrite, so any unrelated overwrites the guild had configured survive.
  private async restoreChannelPermissions(channel: TextChannel, guild: Guild): Promise<void> {
    this.configuredChannelPermissions.delete(channel.id);
    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { UseApplicationCommands: null },
      { reason: "Music control channel is no longer reserved for the panel" },
    ).catch((error: unknown) => {
      this.logger.warn(
        { error, guildId: guild.id, channelId: channel.id },
        "Unable to restore music control channel permissions",
      );
    });
  }

  private createNowPlayingPayload(
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
  ): ControlPanelPayload {
    const embed = this.createNowPlayingEmbed(profile, snapshot);
    const requestersHint = profile.music.openQueueRequestsEnabled
      ? "Anyone can queue songs here by name or URL."
      : "Members with the music-controller role can queue songs here by name or URL.";

    return {
      content: `Join a voice channel. ${requestersHint}\n` +
        "-# ♾️ Autoqueue: automatically adds a similar track when the queue runs out.  •  🔁 24/7: keeps the bot connected instead of leaving when idle.",
      embeds: [embed],
      components: [],
    };
  }

  private createNowPlayingEmbed(
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
    embed
      .setTitle(snapshot.paused ? "Playback paused" : "Now Playing")
      .setDescription(`### ${title}\n${track.author}\n\n${progress}${requester}`);

    if (track.artworkUrl) embed.setImage(track.artworkUrl);
    return embed;
  }

  private createLyricsPayload(
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
  ): ControlPanelPayload {
    return { content: "", embeds: [this.createLyricsEmbed(profile, snapshot)], components: [] };
  }

  private createLyricsEmbed(
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
  ): EmbedBuilder {
    const embed = new EmbedBuilder().setColor(profile.embedColor as `#${string}`).setTitle("🎤 Lyrics");
    if (!snapshot?.currentTrack) {
      return embed.setDescription("Nothing is playing right now.");
    }
    if (snapshot.currentLyricLine) {
      // Bundling every line due before the next repaint (rather than just
      // one "next" line) is what keeps this useful during fast sections —
      // without it, lines that fire between repaints would just be
      // silently skipped.
      const upcoming = snapshot.upcomingLyricLines.length > 0
        ? `\n-# ${snapshot.upcomingLyricLines.join(" / ")}`
        : "";
      return embed.setDescription(`${snapshot.currentLyricLine}${upcoming}`);
    }
    return embed.setDescription(
      snapshot.lyricsUnavailable ? "No lyrics found for this track." : "Looking for lyrics…",
    );
  }

  private createQueueControlsPayload(
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
  ): ControlPanelPayload {
    return {
      content: "",
      embeds: [this.createQueueEmbed(profile, snapshot)],
      components: createMusicPanelControlRows(profile, snapshot),
    };
  }

  private createQueueEmbed(
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
  ): EmbedBuilder {
    const embed = new EmbedBuilder().setColor(profile.embedColor as `#${string}`).setTitle("Queue");
    const tracks = this.playerGateway.getQueue(profile.guildId);
    const queueLength = snapshot?.queueLength ?? tracks.length;

    embed.setDescription(
      queueLength === 0
        ? "Nothing queued."
        : `**${queueLength} in queue** (total ${formatQueueDuration(this.sumTrackDurations(tracks))})\n${this.buildQueueLines(tracks)}`,
    );

    if (snapshot?.currentTrack) {
      const queueStatus = queueLength === 0 ? "Queue empty" : `${queueLength} queued`;
      const autoQueueNote = snapshot.autoQueue && snapshot.autoQueueIssue
        ? "  •  ⚠️ Autoqueue found nothing to add"
        : "";
      embed.setFooter({
        text: `🔊 ${snapshot.volume}%  •  ${queueStatus}  •  Loop ${snapshot.repeatMode}${autoQueueNote}`,
      });
    }

    return embed;
  }

  private sumTrackDurations(tracks: readonly MusicTrack[]): number {
    return tracks.reduce((total, track) => total + (track.isStream ? 0 : track.durationMs), 0);
  }

  // Char-budgeted rather than count-capped: with a whole dedicated message
  // for the queue there's room to show far more than a handful of tracks,
  // but the exact count that fits depends on title length, so this stops
  // adding lines once the embed description's real limit is within reach
  // instead of guessing a fixed number up front.
  private buildQueueLines(tracks: readonly MusicTrack[]): string {
    const lines: string[] = [];
    let used = 0;
    let shown = 0;
    for (const track of tracks) {
      const label = this.truncateTrackTitle(track.title);
      const titleText = track.uri ? `[${label}](${track.uri})` : label;
      const line = `${shown + 1}. ${titleText}${this.formatQueueRequester(track.requestedByUserId)}`;
      if (used + line.length + 1 > queueListCharBudget) break;
      lines.push(line);
      used += line.length + 1;
      shown += 1;
    }
    const remaining = tracks.length - shown;
    if (remaining > 0) lines.push(`…and ${remaining} more — use \`/queue show\` for the rest`);
    return lines.join("\n");
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

  // Compact form for the queue list — one entry per line, so a full mention
  // phrase per track ("Requested by @x") would eat into the char budget
  // fast. Just the mention is enough context there.
  private formatQueueRequester(requestedByUserId: string): string {
    return requestedByUserId === "autoqueue" ? " — Autoqueue" : ` — <@${requestedByUserId}>`;
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

  // Gates song-request typing only (not button controls, which always go
  // through canControl). When openQueueRequestsEnabled is off this is
  // identical to canControl; when on, any non-restricted member qualifies —
  // not just musicController/botAdministrator.
  private canRequestSongs(
    member: GuildMember,
    userId: string,
    profile: GuildConfiguration,
  ): boolean {
    if (!profile.music.openQueueRequestsEnabled) {
      return this.canControl(member, userId, profile);
    }

    const isOwner = this.applicationConfiguration.ownerUserIds.has(userId);
    return isOwner || !this.hasRestrictedRole(member, profile);
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
    if (this.stopped || !snapshot?.currentTrack || snapshot.paused) return;

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
