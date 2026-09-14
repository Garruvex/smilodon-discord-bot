import {
  type ActionRowBuilder,
  type ButtonBuilder,
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  RESTJSONErrorCodes,
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
import { formatQueueDuration, formatQueueTrackLine, sumTrackDurations } from "../music/queue-formatting.js";
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
// The wake-timer's own outer bound: how long to wait at most before
// re-checking state, even when nothing else demands sooner (no current
// lyrics, or the next line is far off). Merely ticking is cheap — a tick
// with nothing new to show skips its edit entirely (matchesCurrentMessage) —
// so this can stay reasonably tight without costing anything on its own;
// what actually costs Discord edit budget is the two throttles below.
const activePlaybackRefreshIntervalMs = 3_000;
// The progress bar's own edit throttle. Split out from the lyrics throttle
// below (they used to share one interval) so lyrics — what's actually being
// read line by line — can update meaningfully more often than mm:ss ticking
// over, which doesn't need anywhere near that precision.
const nowPlayingRefreshIntervalMs = 6_000;
// Lyrics' own edit throttle. This used to match activePlaybackRefreshIntervalMs
// (3s) after a smaller 1s floor let total edit volume for this guild alone
// approach Discord's ~5-edits-per-5s-per-channel ceiling by itself — real
// 429 backoff then stalled panelWriteQueue for however long Discord made it
// wait, and since button clicks share that same queue, every control on the
// panel went unresponsive for the same stretch. Worst case combined with
// nowPlayingRefreshIntervalMs above: 1/1.5s + 1/6s ≈ 0.83 edits/s ≈ 4.2 per
// 5s — real but tighter headroom than the old 3s+3s split, traded
// deliberately in favor of lyrics actually looking synced. Watch the
// rateLimited REST log (bootstrap/application.ts) after changing either of
// these — that's the ground truth for whether there's still headroom.
const minimumLyricEditIntervalMs = 1_500;
const defaultIdleImagePath = resolve("assets/music/no_bg.png");
// Leaves headroom under the embed description's 4096-char hard cap for the
// header line and the "…and N more" note appended after this budget runs out.
const queueListCharBudget = 3_500;

// A message fetched back from Discord carries fields we never set ourselves
// (e.g. `type: "rich"`, and width/height/proxy_url on images) — comparing
// the full JSON against our own freshly-built embed would then never match,
// even when nothing actually changed, defeating matchesCurrentMessage's
// whole purpose and forcing a real edit (and its rate-limit cost) on every
// single refresh. Only compare the fields we actually set.
function normalizeEmbedForComparison(embed: {
  title?: string | null;
  description?: string | null;
  color?: number | null;
  url?: string | null;
  image?: { url?: string | null } | null;
  footer?: { text?: string | null } | null;
} | undefined): unknown {
  if (!embed) return undefined;
  return {
    title: embed.title ?? null,
    description: embed.description ?? null,
    color: embed.color ?? null,
    url: embed.url ?? null,
    image: embed.image?.url ?? null,
    footer: embed.footer?.text ?? null,
  };
}

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

export class ControlChannelService {
  private readonly progressRefreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastLyricsEditAt = new Map<string, number>();
  private readonly lastNowPlayingEditAt = new Map<string, number>();
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
      if (event.reason === "lyrics_loaded") {
        this.logger.info(
          { guildId: event.guildId, reason: event.reason, time: Date.now() },
          "Panel refresh requested for freshly-resolved lyrics",
        );
      }
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
    this.lastLyricsEditAt.clear();
    this.lastNowPlayingEditAt.clear();
  }

  // Called when the bot leaves a guild, so its per-guild timer/permission
  // caches don't grow unbounded across many join/leave cycles.
  public handleGuildRemoved(guildId: string): void {
    this.clearProgressRefreshTimer(guildId);
    this.lastLyricsEditAt.delete(guildId);
    this.lastNowPlayingEditAt.delete(guildId);
    this.refreshCoordinator.stopGuild(guildId);
    const profile = this.guildConfigurationProvider.find(guildId);
    if (profile?.channels.controlPanel) {
      this.configuredChannelPermissions.delete(profile.channels.controlPanel);
    }
  }

  public async ensureGuildPanel(guildId: string): Promise<Message> {
    const profile = this.guildConfigurationProvider.require(guildId);
    // ensurePanelMessages() pins all three on creation, but that only runs
    // when the trio doesn't already exist — existing, somehow-unpinned
    // messages (e.g. manually unpinned) still need catching up here.
    const messages = await this.panelWriteQueue.run(guildId, () => this.ensurePanelMessages(profile));
    await this.pinPanelMessage(messages.nowPlaying, guildId);
    await this.pinPanelMessage(messages.lyrics, guildId);
    await this.pinPanelMessage(messages.queue, guildId);
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
    // The capture → predict → optimistic-write → execute pipeline runs as
    // one action-queue turn. That's what makes the prediction correct (a
    // queued second click reads state *after* this click's execute()
    // actually ran, not a snapshot taken before either ran). The
    // authoritative write is deliberately NOT part of this turn (see below)
    // — it only *renders* already-mutated state, so a queued second click's
    // own guildLocks.run can safely start (and read correct, post-execute
    // state) as soon as this click's execute() settles, without waiting for
    // that render to actually reach Discord.
    try {
      await this.guildLocks.run(interaction.guildId, async () => {
        try {
          // The bot's actual Discord voice connection is authoritative over
          // whatever channel the Lavalink player still thinks it's in. A
          // mismatch (kick, channel deletion, a missed VoiceStateUpdate) means
          // the player is stale — destroy it now rather than let
          // channel-mismatch checks (e.g. 24/7's assertControllablePlayer)
          // permanently block every control, including the one that would have
          // turned the stale session off. Inside the try so a failure here
          // (e.g. a transient Discord API error) still reaches the
          // authoritative write and the user-facing error reply below, instead
          // of leaving the button stuck in its optimistic pending state with
          // no explanation.
          staleRecovered = await this.playerGateway.reconcileVoiceState(interaction.guildId);
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
              // Submitted into the write queue — preserving its order relative
              // to any write already in flight or queued — but deliberately
              // not awaited: this is a cosmetic "button looks pressed" hint,
              // and the actual playback command below must not sit behind a
              // Discord round trip (or a slow, unrelated queued edit) that has
              // nothing to do with whether playback actually happens.
              void this.panelWriteQueue.run(interaction.guildId, () =>
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
        }
      });
    } finally {
      // Always reconcile the panel with ground truth, success or failure, so
      // a failed action can never leave the optimistic prediction stuck on
      // screen. Deliberately outside guildLocks — this write only reflects
      // already-mutated state, so it doesn't need to hold up the next
      // click's action-queue turn; it still funnels through panelWriteQueue,
      // so it can't race a background/event-driven write either. Bypasses
      // the background debounce scheduler entirely — user interaction
      // feedback goes straight into the write queue with immediate priority.
      await this.writePanel(interaction.guildId, profile, {});
    }

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

  // The full trio — used by every event-driven refresh (track change, queue
  // mutation, a button's own authoritative write). The periodic progress
  // tick uses writeTimedPanels() instead, which skips the queue message —
  // its content only ever changes in response to a real mutation, so a
  // time-based tick has nothing new to say there.
  private async writePanel(
    guildId: string,
    profile: GuildConfiguration,
    options: PanelRefreshOptions,
  ): Promise<void> {
    await this.panelWriteQueue.run(guildId, async () => {
      const messages = await this.ensurePanelMessages(profile).catch((error: unknown) => {
        this.logger.error({ error, guildId }, "Unable to ensure music control panel messages");
        return null;
      });
      if (!messages) {
        this.resetProgressRefreshTimer(guildId, this.playerGateway.getSnapshot(guildId));
        return;
      }
      const snapshot = this.playerGateway.getSnapshot(profile.guildId);
      // Each write is independently try/caught — one message's edit
      // throwing (e.g. an unexpected API error) must not skip the other
      // two for this cycle.
      await this.writeQueueMessage(messages.queue, profile, snapshot, guildId);
      await this.writeNowPlayingMessage(messages.nowPlaying, profile, this.playerGateway.getSnapshot(guildId), options, guildId);
      // Lyrics written last, off the freshest snapshot available — a slow
      // Now Playing edit above must not leave the displayed line stale by
      // however long that edit took. Writing lyrics after it (instead of
      // before, off an older snapshot) means the line shown always reflects
      // what's truly playing right now, not what was playing when this
      // refresh started.
      await this.writeLyricsMessage(messages.lyrics, profile, this.playerGateway.getSnapshot(guildId), guildId);
      // Slow edits must not add their elapsed time to the next line's delay.
      // Schedule from a fresh position even when a message edit failed.
      this.resetProgressRefreshTimer(guildId, this.playerGateway.getSnapshot(guildId));
    });
  }

  // The periodic progress-tick path: only Now Playing (the progress bar)
  // and Lyrics are time-sensitive enough to need a tick with no triggering
  // event. Still funnels through panelWriteQueue like every other write.
  private async writeTimedPanels(guildId: string): Promise<void> {
    const profile = this.guildConfigurationProvider.find(guildId);
    if (!profile?.channels.controlPanel || !profile.features.music) {
      this.clearProgressRefreshTimer(guildId);
      return;
    }

    // This whole method runs detached (`void writeTimedPanels(...)` from the
    // timer callback in resetProgressRefreshTimer) — nothing awaits it or
    // catches a rejection, so an uncaught error here becomes an unhandled
    // promise rejection, which crashes the whole process under Node's
    // default unhandled-rejection behavior. A single tick failing (a
    // transient Discord/Lavalink error) must not take the bot down; the next
    // tick or event-driven refresh will simply pick it back up.
    try {
      await this.guildLocks.run(guildId, () => this.playerGateway.reconcileVoiceState(guildId));
    } catch (error) {
      this.logger.error({ error, guildId }, "Unable to reconcile voice state during a timed panel refresh");
      // Re-arm the timer from current state anyway — otherwise a single
      // transient failure silently stops the progress tick for this guild
      // until some unrelated event happens to trigger a refresh.
      this.resetProgressRefreshTimer(guildId, this.playerGateway.getSnapshot(guildId));
      return;
    }
    await this.panelWriteQueue.run(guildId, async () => {
      const messages = await this.ensurePanelMessages(profile).catch((error: unknown) => {
        this.logger.error({ error, guildId }, "Unable to ensure music control panel messages");
        return null;
      });
      if (!messages) {
        this.resetProgressRefreshTimer(guildId, this.playerGateway.getSnapshot(guildId));
        return;
      }
      if (Date.now() - (this.lastNowPlayingEditAt.get(guildId) ?? -Infinity) >= nowPlayingRefreshIntervalMs) {
        await this.writeNowPlayingMessage(messages.nowPlaying, profile, this.playerGateway.getSnapshot(guildId), {}, guildId);
      }
      // Lyrics last, off the freshest snapshot — see the matching comment in
      // writePanel() above for why.
      await this.writeLyricsMessage(messages.lyrics, profile, this.playerGateway.getSnapshot(guildId), guildId);
      this.resetProgressRefreshTimer(guildId, this.playerGateway.getSnapshot(guildId));
    });
  }

  private async writeNowPlayingMessage(
    message: Message,
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
    options: PanelRefreshOptions,
    guildId: string,
  ): Promise<void> {
    try {
      const payload = this.createNowPlayingPayload(profile, snapshot);
      const editOptions = this.createNowPlayingEditOptions(message, profile, snapshot, payload, options);
      if (!this.matchesCurrentMessage(message, editOptions)) {
        this.lastNowPlayingEditAt.set(guildId, Date.now());
        await message.edit(editOptions);
      }
    } catch (error) {
      this.logger.error({ error, guildId }, "Unable to refresh the Now Playing panel message");
    }
  }

  private async writeLyricsMessage(
    message: Message,
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
    guildId: string,
  ): Promise<void> {
    try {
      const payload = this.createLyricsPayload(profile, snapshot);
      if (!this.matchesCurrentMessage(message, payload)) {
        this.lastLyricsEditAt.set(guildId, Date.now());
        const startedAt = Date.now();
        await message.edit(payload);
        this.logger.info(
          { guildId, editMs: Date.now() - startedAt, time: Date.now(), line: snapshot?.currentLyricLine ?? null },
          "Lyrics panel message edited",
        );
      }
    } catch (error) {
      this.logger.error({ error, guildId }, "Unable to refresh the Lyrics panel message");
    }
  }

  private async writeQueueMessage(
    message: Message,
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
    guildId: string,
  ): Promise<void> {
    try {
      const payload = this.createQueueControlsPayload(profile, snapshot);
      if (!this.matchesCurrentMessage(message, payload)) {
        await message.edit(payload);
      }
    } catch (error) {
      this.logger.error({ error, guildId }, "Unable to refresh the Queue panel message");
    }
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

    // Pinned here (not just in ensureGuildPanel) so a mid-session trio
    // recreation — triggered by any writePanel() call, not only the setup
    // flow — pins the fresh messages too, instead of leaving them unpinned
    // until someone happens to call ensureGuildPanel() again.
    await this.pinPanelMessage(nowPlaying, profile.guildId);
    await this.pinPanelMessage(lyrics, profile.guildId);
    await this.pinPanelMessage(queue, profile.guildId);

    return { nowPlaying, lyrics, queue };
  }

  private async pinPanelMessage(message: Message, guildId: string): Promise<void> {
    if (message.pinned) return;
    await message.pin("Persistent music control panel").catch((error: unknown) => {
      this.logger.warn({ error, guildId, messageId: message.id }, "Unable to pin music control panel message");
    });
  }

  // Only an authoritative "this message is really gone" (Unknown Message)
  // should be treated as missing — anything else (a transient 500/503, a
  // network blip) must propagate instead of being swallowed as `null`, or
  // fetchExistingTrio would read a temporary API hiccup as "the trio is
  // broken" and delete + recreate all three messages over a blip that would
  // have resolved on its own by the next refresh.
  private async fetchPanelMessage(channel: TextChannel, messageId: string): Promise<Message | null> {
    try {
      return await channel.messages.fetch(messageId);
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) return null;
      throw error;
    }
  }

  private async fetchExistingTrio(
    channel: TextChannel,
    state: ControlPanelRuntimeState,
  ): Promise<PanelMessageTrio | null> {
    if (!state.nowPlayingMessageId || !state.lyricsMessageId || !state.queueMessageId) return null;

    const [nowPlaying, lyrics, queue] = await Promise.all([
      this.fetchPanelMessage(channel, state.nowPlayingMessageId),
      this.fetchPanelMessage(channel, state.lyricsMessageId),
      this.fetchPanelMessage(channel, state.queueMessageId),
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
    const message = await channel.send(
      needsIdleAttachment ? { ...payload, files: [this.getIdleImageFile(profile)] } : payload,
    );
    return message;
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
      ? currentEmbed !== undefined &&
        isDeepStrictEqual(normalizeEmbedForComparison(newEmbed.toJSON()), normalizeEmbedForComparison(currentEmbed.toJSON()))
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

  // "disc_spin"/"disc_static" application emoji (see application-emoji-presets.ts)
  // give the panel titles a visual playing/idle-or-paused cue. Falls back to
  // a plain Unicode disc when the emoji hasn't been uploaded yet (see
  // instance:emojis:sync) rather than showing nothing.
  private musicDiscIcon(snapshot: MusicPlayerSnapshot | null): string {
    const playing = Boolean(snapshot?.currentTrack) && !snapshot?.paused;
    return this.applicationEmojiCatalog.getEmojiTag(playing ? "disc_spin" : "disc_static") ?? "💿";
  }

  private createNowPlayingEmbed(
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
  ): EmbedBuilder {
    const embed = new EmbedBuilder().setColor(profile.embedColor as `#${string}`);
    if (!snapshot?.currentTrack) {
      embed
        .setTitle(`${this.musicDiscIcon(snapshot)} No song currently playing`)
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
      .setTitle(`${this.musicDiscIcon(snapshot)} ${snapshot.paused ? "Playback paused" : "Now Playing"}`)
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
    const embed = new EmbedBuilder()
      .setColor(profile.embedColor as `#${string}`)
      .setTitle("🎤 Lyrics");
    if (!snapshot?.currentTrack) {
      return embed.setDescription("Nothing is playing right now.");
    }
    if (snapshot.currentLyricLine) {
      // Bundling every line due before the next repaint (rather than just
      // one "next" line) is what keeps this useful during fast sections —
      // without it, lines that fire between repaints would just be
      // silently skipped. One per line (not joined into a single string) so
      // a wider window of several lines stays readable instead of running
      // together.
      const upcoming = snapshot.upcomingLyricLines.length > 0
        ? `\n${snapshot.upcomingLyricLines.map((line) => `-# ${line}`).join("\n")}`
        : "";
      return embed.setDescription(`${snapshot.currentLyricLine}${upcoming}`);
    }
    // No line has started yet (e.g. still in the intro), but the first one
    // is coming up within the lookahead window — show it rather than a
    // placeholder that would just get replaced a couple of seconds later.
    if (snapshot.upcomingLyricLines.length > 0) {
      return embed.setDescription(snapshot.upcomingLyricLines.map((line) => `-# ${line}`).join("\n"));
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
        : `**${queueLength} in queue** (total ${formatQueueDuration(sumTrackDurations(tracks))})\n${this.buildQueueLines(tracks)}`,
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
      const line = formatQueueTrackLine(track, shown + 1);
      if (used + line.length + 1 > queueListCharBudget) break;
      lines.push(line);
      used += line.length + 1;
      shown += 1;
    }
    const remaining = tracks.length - shown;
    if (remaining > 0) lines.push(`…and ${remaining} more — use \`/queue show\` for the rest`);
    return lines.join("\n");
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

    const nextLine = snapshot.nextLyricLineInMs;
    const lyricDelay = typeof nextLine === "number" && Number.isFinite(nextLine)
      ? Math.max(25, nextLine, minimumLyricEditIntervalMs - (Date.now() - (this.lastLyricsEditAt.get(guildId) ?? -Infinity)))
      : activePlaybackRefreshIntervalMs;
    const delay = Math.min(activePlaybackRefreshIntervalMs, lyricDelay);

    const timer = setTimeout(() => {
      this.progressRefreshTimers.delete(guildId);
      void this.writeTimedPanels(guildId);
    }, delay);
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
