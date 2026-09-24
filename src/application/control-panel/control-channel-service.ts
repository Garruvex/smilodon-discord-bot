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
import { musicErrorText, MusicError } from "../music/music-errors.js";
import type { MusicPlayerGateway, MusicPlayerSnapshot } from "../music/music-player-gateway.js";
import type { MusicTrack } from "../../domain/music/music-track.js";
import { formatQueueDuration, formatQueueTrackLine, sumTrackDurations } from "../music/queue-formatting.js";
import { cleanArtistName } from "../../domain/music/artist-name.js";
import type { ApplicationConfiguration } from "../../config/configuration.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type {
  ControlPanelRuntimeState,
  ControlPanelStateStore,
} from "./control-panel-state-store.js";
import { defaultLanguage } from "../i18n/language.js";
import { textForGuild } from "../i18n/guild-text.js";
import { texts, type Texts } from "../i18n/texts.js";
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
import {
  autoQueueVoteClosesAtSeconds,
  autoQueueVoteIdPrefix,
  createAutoQueueVotePayload,
  parseAutoQueueVoteCustomId,
} from "./auto-queue-vote-message.js";

const defaultIdleImageName = "music-idle.png";
// The master panel (Now Playing progress bar + queue/controls) is
// long-lived and edited in place for the whole session, unlike Lyrics (see
// ensureLyricsMessage) — a flat, simple interval for both the wake-tick and
// the Now Playing edit floor, replacing an earlier split between an outer
// "how often to check" tick and an inner "how often to actually edit"
// floor. A progress bar only needs to be roughly right; 5s granularity
// reads fine and is one number to reason about instead of two.
const masterPanelRefreshIntervalMs = 5_000;
// Lyrics' own edit throttle, within one track's lyrics message. Was
// tightened to 1s, then to 1.5s, chasing tighter lyric sync — both times
// confirmed (via production REST response logging, since discord.js's
// rateLimited event doesn't catch this case; see the comment on that
// listener in bootstrap/application.ts) to trigger real 429s from
// Discord's per-channel message-edit sublimit. Recreating the lyrics
// message per track (see ensureLyricsMessage) bounds how much edit
// history any single message can accumulate, but doesn't remove the need
// for a sane floor within a track's own lifetime. If you change this,
// watch the "Discord REST response for a message route" log
// (bootstrap/application.ts) for status 429 afterward — that's the
// ground truth, not the rateLimited listener.
const minimumLyricEditIntervalMs = 3_000;
// Upper bound on how many recent messages a channel sweep inspects (see
// sweepControlChannel) — comfortably more than this reserved channel
// should ever actually accumulate between sweeps, and the max a single
// Discord history fetch allows anyway.
const channelSweepFetchLimit = 100;
const defaultIdleImagePath = resolve("assets/music/no_bg.png");
// A longer queue was making the panel read as a scrollable wall of text
// rather than an at-a-glance preview — capped to a handful of upcoming
// tracks; the rest is always available via `/queue show`.
const queueDisplayLimit = 5;
// Leaves headroom under the embed description's 4096-char hard cap for the
// header line and the "…and N more" note appended after this budget runs out.
const queueListCharBudget = 3_500;
// How far the vote countdown may drift before the vote message is edited
// just to correct it (see writeVoteMessage).
const voteCountdownToleranceSeconds = 5;

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

// The two long-lived panel messages — Lyrics is deliberately not part of
// this pair; see ensureLyricsMessage for why it's tracked separately.
interface PanelMessagePair {
  channel: TextChannel;
  nowPlaying: Message;
  queue: Message;
}

export class ControlChannelService {
  private readonly progressRefreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastLyricsEditAt = new Map<string, number>();
  private readonly lastNowPlayingEditAt = new Map<string, number>();
  // The current track's lyrics message, and an identity key for the track
  // it belongs to — see ensureLyricsMessage. Not persisted: a fresh
  // session always starts with no lyrics message and creates one lazily on
  // the first refresh, which sweepControlChannel relies on (nothing to
  // preserve for it at sweep time).
  private readonly lyricsMessageByGuild = new Map<string, Message>();
  private readonly lyricsTrackKeyByGuild = new Map<string, string | null>();
  // The "what plays next" vote message: posted when a vote opens, deleted
  // when it closes, and replaced (so it lands at the bottom of the channel)
  // for each new track. Transient like the lyrics message, so it is
  // likewise not persisted; a leftover one is swept at the next panel setup.
  private readonly voteMessageByGuild = new Map<string, Message>();
  private readonly voteTrackKeyByGuild = new Map<string, string>();
  private readonly voteClosesAtByGuild = new Map<string, number | null>();
  private readonly configuredChannelPermissions = new Set<string>();
  private readonly refreshCoordinator: PanelRefreshCoordinator;
  // The action queue: serializes per-guild playbackService/playerGateway
  // mutations (button clicks, voice-state reconciliation) so a double-click
  // can't race the same toggle twice, and so a queued second click always
  // captures/predicts from the first click's *actual* post-execution state
  // rather than a snapshot read before either ran.
  private readonly guildLocks = new KeyedSerialQueue();
  // The write queue: serializes every actual Discord write to the panel's
  // messages per guild — both the button handler's optimistic edit and
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
    this.lyricsMessageByGuild.clear();
    this.lyricsTrackKeyByGuild.clear();
    this.voteMessageByGuild.clear();
    this.voteTrackKeyByGuild.clear();
    this.voteClosesAtByGuild.clear();
  }

  // Called when the bot leaves a guild, so its per-guild timer/permission
  // caches don't grow unbounded across many join/leave cycles.
  public handleGuildRemoved(guildId: string): void {
    this.clearProgressRefreshTimer(guildId);
    this.lastLyricsEditAt.delete(guildId);
    this.lastNowPlayingEditAt.delete(guildId);
    this.lyricsMessageByGuild.delete(guildId);
    this.lyricsTrackKeyByGuild.delete(guildId);
    this.forgetVoteMessage(guildId);
    this.refreshCoordinator.stopGuild(guildId);
    const profile = this.guildConfigurationProvider.find(guildId);
    if (profile?.channels.controlPanel) {
      this.configuredChannelPermissions.delete(profile.channels.controlPanel);
    }
  }

  public async ensureGuildPanel(guildId: string): Promise<Message> {
    const profile = this.guildConfigurationProvider.require(guildId);
    // ensurePanelMessages() pins both on creation, but that only runs when
    // the pair doesn't already exist — existing, somehow-unpinned messages
    // (e.g. manually unpinned) still need catching up here. Lyrics is
    // never pinned (see ensureLyricsMessage) — it's recreated per track, so
    // pinning it would mean re-pinning on every track change for no real
    // benefit, since it's inherently transient/current rather than
    // something worth being individually discoverable via the pins list.
    const messages = await this.panelWriteQueue.run(guildId, () => this.ensurePanelMessages(profile));
    await this.pinPanelMessage(messages.nowPlaying, guildId);
    await this.pinPanelMessage(messages.queue, guildId);
    // Run at every panel setup (startup, and whenever an admin
    // reconfigures the control channel via /settings) rather than on a
    // recurring schedule — catches anything left behind by a restart that
    // interrupted a transient message's self-deletion timer, a failed
    // best-effort delete, or a stray message from before the bot ever
    // touched this channel, without adding a recurring channel-history
    // fetch to the steady-state refresh cycle.
    const voteMessageId = this.voteMessageByGuild.get(guildId)?.id;
    await this.sweepControlChannel(
      messages.channel,
      new Set([messages.nowPlaying.id, messages.queue.id, ...(voteMessageId ? [voteMessageId] : [])]),
    );
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

    const text = texts[profile.language];
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
      const denied = await message.reply(text.music.panel.request.denied);
      this.scheduleDeletion(denied);
      await message.delete().catch(() => undefined);
      return true;
    }

    const statusMessage = await message.reply(text.music.panel.request.searching);

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
        embeds: [createQueuedTrackCard(result, profile.embedColor as `#${string}`, text)],
      });
      this.scheduleDeletion(statusMessage, queuedTrackCardLifetimeMs);
    } catch (error) {
      this.logger.warn(
        { error, guildId: message.guildId, userId: message.author.id },
        "Control-channel request failed",
      );
      await statusMessage.edit(
        error instanceof MusicError
          ? musicErrorText(error, text)
          : text.music.panel.request.failed,
      );
      this.scheduleDeletion(statusMessage, failedMusicRequestLifetimeMs);
    } finally {
      await this.refreshPanel(message.guildId);
    }

    return true;
  }

  public async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (interaction.customId.startsWith(autoQueueVoteIdPrefix)) {
      return this.handleVoteButton(interaction);
    }
    if (!interaction.customId.startsWith(musicPanelControlIdPrefix)) {
      return false;
    }

    // The guild's language, or English when the press isn't in a (known)
    // guild — these replies are the only text a button press can produce
    // before the guild profile is looked up below.
    const text = texts[
      (interaction.guildId ? this.guildConfigurationProvider.find(interaction.guildId)?.language : undefined) ??
        defaultLanguage
    ];
    const control = findMusicPanelControl(interaction.customId);
    if (!control) {
      await interaction.reply({
        content: text.music.panel.control.unsupported,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: text.music.panel.control.guildOnly,
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
        content: text.music.panel.control.obsolete,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (!profile || !this.canControl(interaction.member, interaction.user.id, profile)) {
      await interaction.reply({
        content: text.music.panel.control.denied,
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
        text.music.panel.control.staleReset,
      );
    } else if (executionError) {
      await this.replyEphemeral(
        interaction,
        executionError instanceof MusicError ? musicErrorText(executionError, text) : text.music.panel.control.failed,
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
      await this.writeLyricsMessage(messages.channel, profile, this.playerGateway.getSnapshot(guildId), guildId);
      await this.writeVoteMessage(messages.channel, profile, this.playerGateway.getSnapshot(guildId), guildId);
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
      // The interval floor now lives inside writeNowPlayingMessage/
      // writeLyricsMessage themselves (applies to every caller, not just
      // this tick path) — no need to gate the call here too.
      await this.writeNowPlayingMessage(messages.nowPlaying, profile, this.playerGateway.getSnapshot(guildId), {}, guildId);
      // Lyrics last, off the freshest snapshot — see the matching comment in
      // writePanel() above for why.
      await this.writeLyricsMessage(messages.channel, profile, this.playerGateway.getSnapshot(guildId), guildId);
      // The vote locks on playback position, not on any event, so this tick
      // is what flips its message to the closed view in the final stretch.
      await this.writeVoteMessage(messages.channel, profile, this.playerGateway.getSnapshot(guildId), guildId);
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
      // Floor applies here — not just in the periodic-tick caller — so an
      // event-driven refresh (track_started, lyrics_loaded, queue_changed,
      // ...) can't stack its own edit on top of one the tick just sent.
      // Confirmed via production REST logging: real 429s from Discord's
      // per-channel message-edit sublimit kept happening even after tuning
      // the tick-only interval, because this path had no floor of its own
      // at all — only a "did the content change" check, which a genuine
      // track change always passes. A skip here isn't lost — the next
      // scheduled tick (resetProgressRefreshTimer) or a later event picks
      // it up.
      if (Date.now() - (this.lastNowPlayingEditAt.get(guildId) ?? -Infinity) < masterPanelRefreshIntervalMs) return;
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

  // A track identity key for ensureLyricsMessage — good enough to detect
  // "this is a different song" for the panel's purposes without needing
  // Lavalink's own internal track id, which isn't exposed at this layer.
  private lyricsTrackKey(snapshot: MusicPlayerSnapshot | null): string | null {
    if (snapshot?.lyricsEnabled !== true) return null;
    const track = snapshot?.currentTrack;
    return track ? `${track.title}|${track.author}|${track.uri}` : null;
  }

  // Recreates the lyrics message whenever the track changes, instead of
  // editing one message for the guild's entire session. Confirmed via
  // production REST response logging: a single lyrics message, edited
  // roughly every few seconds for a long stretch, tripped an undocumented
  // Discord per-message sublimit that took several real seconds to clear on
  // every subsequent edit — and recreating that one message with a fresh
  // one immediately cleared it. Rotating per track bounds any single
  // message to roughly one song's worth of edits (tens, not hundreds+),
  // keeping it well clear of whatever triggers that state. Not pinned
  // (see ensureGuildPanel) and not persisted for cross-restart recovery —
  // it's inherently transient, and a fresh session just creates one lazily
  // on the first refresh (see sweepControlChannel, which relies on that).
  private async ensureLyricsMessage(
    channel: TextChannel,
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
    guildId: string,
  ): Promise<{ message: Message | null; justCreated: boolean }> {
    const trackKey = this.lyricsTrackKey(snapshot);
    const cached = this.lyricsMessageByGuild.get(guildId);
    if (cached && this.lyricsTrackKeyByGuild.get(guildId) === trackKey) {
      return { message: cached, justCreated: false };
    }

    if (cached) {
      await cached.delete().catch((error: unknown) => {
        this.logger.warn({ error, guildId, messageId: cached.id }, "Unable to delete the previous lyrics panel message");
      });
      this.lyricsMessageByGuild.delete(guildId);
      this.lyricsTrackKeyByGuild.delete(guildId);
    }
    // Nothing playing (bot startup, or the previous track just ended with
    // nothing queued next) — no lyrics message needed; creating one just to
    // say "Nothing is playing right now" would immediately get deleted and
    // resent again the moment a real track actually starts.
    if (trackKey === null) return { message: null, justCreated: false };

    const message = await channel.send(this.createLyricsPayload(profile, snapshot));
    this.lyricsMessageByGuild.set(guildId, message);
    this.lyricsTrackKeyByGuild.set(guildId, trackKey);
    // Best-effort only (see the type above) — kept purely for visibility/
    // debugging, never read back to recover or validate a lyrics message.
    const state = this.stateStore.find(guildId);
    if (state) {
      await this.stateStore.save({ ...state, lyricsMessageId: message.id }).catch((error: unknown) => {
        this.logger.warn({ error, guildId }, "Unable to record the current lyrics message id");
      });
    }
    return { message, justCreated: true };
  }

  private async writeLyricsMessage(
    channel: TextChannel,
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
    guildId: string,
  ): Promise<void> {
    try {
      const { message, justCreated } = await this.ensureLyricsMessage(channel, profile, snapshot, guildId);
      // Nothing playing, and no leftover message to clean up either (that
      // part already happened inside ensureLyricsMessage) — nothing to do.
      if (!message) return;
      // A just-created message was sent with this exact content, via
      // channel.send() above — nothing left to do this cycle.
      if (justCreated) return;
      // Same floor-applies-to-every-caller reasoning as writeNowPlayingMessage
      // above — this was the dominant contributor: a track change fires
      // track_started (writes the "Looking for lyrics..." placeholder) and
      // then lyrics_loaded moments later (writes the real line), each an
      // independent, fully unthrottled writePanel() cycle. For a genuinely
      // new track the placeholder write always passes this check (the prior
      // track's last lyrics edit is long past by then); it's specifically
      // the *second* write, landing within the floor of the first, that
      // this was letting through uncounted.
      if (Date.now() - (this.lastLyricsEditAt.get(guildId) ?? -Infinity) < minimumLyricEditIntervalMs) return;
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

  // Keeps the vote message's existence in step with the snapshot: posted
  // once a vote has options, edited as votes come in (or on a reroll),
  // deleted the moment it closes. A new track's vote replaces the previous
  // message outright, so each vote is a fresh post at the bottom of the
  // channel rather than one message edited for the whole session.
  private async writeVoteMessage(
    channel: TextChannel,
    profile: GuildConfiguration,
    snapshot: MusicPlayerSnapshot | null,
    guildId: string,
  ): Promise<void> {
    try {
      const vote = snapshot?.autoQueueVote;
      const trackKey = snapshot?.currentTrack && vote?.status === "ready"
        ? `${snapshot.currentTrack.title}|${snapshot.currentTrack.author}|${snapshot.currentTrack.uri}`
        : null;
      const cached = this.voteMessageByGuild.get(guildId);
      if (cached && this.voteTrackKeyByGuild.get(guildId) !== trackKey) {
        this.forgetVoteMessage(guildId);
      }
      if (!snapshot || !trackKey || vote?.status !== "ready") return;

      // Sampled playback position jitters by a second or so between
      // refreshes, which would otherwise turn every vote into a pointless
      // edit just to nudge the countdown. Only move it when it's really off
      // (a seek, or pause/resume).
      const closesAt = autoQueueVoteClosesAtSeconds(vote, snapshot.paused, Date.now());
      const previousClosesAt = this.voteClosesAtByGuild.get(guildId);
      const stableClosesAt = previousClosesAt !== undefined &&
        previousClosesAt !== null &&
        closesAt !== null &&
        Math.abs(previousClosesAt - closesAt) <= voteCountdownToleranceSeconds
        ? previousClosesAt
        : closesAt;
      this.voteClosesAtByGuild.set(guildId, stableClosesAt);
      const payload = createAutoQueueVotePayload(profile, vote, {
        closesAtSeconds: stableClosesAt,
        paused: snapshot.paused,
        currentArtist: cleanArtistName(snapshot.currentTrack?.author ?? ""),
      });

      const existing = this.voteMessageByGuild.get(guildId);
      if (!existing) {
        const message = await channel.send(payload);
        this.voteMessageByGuild.set(guildId, message);
        this.voteTrackKeyByGuild.set(guildId, trackKey);
        return;
      }
      if (!this.matchesCurrentMessage(existing, payload)) await existing.edit(payload);
    } catch (error) {
      // Most likely the message was deleted out from under us; forgetting it
      // lets the next refresh post a replacement.
      this.voteMessageByGuild.delete(guildId);
      this.voteTrackKeyByGuild.delete(guildId);
      this.logger.error({ error, guildId }, "Unable to refresh the autoqueue vote message");
    }
  }

  private forgetVoteMessage(guildId: string): void {
    const message = this.voteMessageByGuild.get(guildId);
    this.voteMessageByGuild.delete(guildId);
    this.voteTrackKeyByGuild.delete(guildId);
    this.voteClosesAtByGuild.delete(guildId);
    void message?.delete().catch((error: unknown) => {
      this.logger.warn({ error, guildId, messageId: message.id }, "Unable to delete the autoqueue vote message");
    });
  }

  private async handleVoteButton(interaction: ButtonInteraction): Promise<boolean> {
    const text = textForGuild(this.guildConfigurationProvider, interaction.guildId);
    const action = parseAutoQueueVoteCustomId(interaction.customId);
    if (!action || !interaction.inCachedGuild()) {
      await interaction.reply({ content: text.music.vote.ended, flags: MessageFlags.Ephemeral });
      return true;
    }
    const profile = this.guildConfigurationProvider.find(interaction.guildId);
    if (
      !profile?.features.music ||
      profile.channels.controlPanel !== interaction.channelId ||
      this.voteMessageByGuild.get(interaction.guildId)?.id !== interaction.message.id
    ) {
      await interaction.reply({ content: text.music.vote.ended, flags: MessageFlags.Ephemeral });
      return true;
    }
    // Voting is open to every listener rather than just music controllers,
    // but a restricted member is still kept out, as everywhere else.
    if (
      this.hasRestrictedRole(interaction.member, profile) &&
      !this.applicationConfiguration.ownerUserIds.has(interaction.user.id)
    ) {
      await interaction.reply({ content: text.music.vote.restricted, flags: MessageFlags.Ephemeral });
      return true;
    }

    // Acknowledged up front: a reroll runs a fresh search, which can take
    // longer than Discord's 3-second interaction window.
    await interaction.deferUpdate();
    const actor = {
      guildId: interaction.guildId,
      textChannelId: interaction.channelId,
      userId: interaction.user.id,
      voiceChannelId: interaction.member.voice.channelId,
      bypassVoiceChannelCheck: false,
      allowQueueWithoutVoiceChannel: false,
    };
    let executionError: unknown;
    try {
      await this.guildLocks.run(interaction.guildId, async () => {
        try {
          if (action.kind === "reroll") await this.playbackService.rerollAutoQueueVote(actor, action.mode);
          else this.playbackService.voteAutoQueue(actor, action.index);
        } catch (error) {
          executionError = error;
        }
      });
    } finally {
      await this.writePanel(interaction.guildId, profile, {});
    }
    if (executionError) {
      await this.replyEphemeral(
        interaction,
        executionError instanceof MusicError ? musicErrorText(executionError, text) : text.music.vote.failed,
      );
    }
    return true;
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

  private async ensurePanelMessages(profile: GuildConfiguration): Promise<PanelMessagePair> {
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
      const existing = await this.fetchExistingPair(channel, state);
      if (existing) return { channel, ...existing };
      // Same channel, but the pair is broken (one message deleted, or a
      // legacy pre-split single-message row) — clean up whatever survives
      // here. No permission change: this channel stays the panel channel.
      // Any lyrics message left over is caught by sweepControlChannel
      // (ensureGuildPanel), not handled specially here.
      await this.deletePanelMessagesBestEffort(channel, state);
      this.forgetLyricsMessage(profile.guildId);
      this.forgetVoteMessage(profile.guildId);
    } else if (state) {
      // The panel moved to a different channel — tear down the old one,
      // including reverting its reserved-for-panel permission overwrite.
      // sweepControlChannel only ever runs on the *current* channel, so
      // this is the one chance to also best-effort clean up the old
      // channel's lyrics message.
      await this.deleteObsoletePanelMessages(profile.guildId, state);
      this.forgetLyricsMessage(profile.guildId);
      this.forgetVoteMessage(profile.guildId);
    }

    const snapshot = this.playerGateway.getSnapshot(profile.guildId);
    // Created in this fixed order (top to bottom) and only ever edited in
    // place afterward, so they stay adjacent regardless of what else gets
    // posted in the channel later — see the recovery paths above for the
    // only case that reorders them (and even then, always recreated
    // together in this same order). Lyrics is sent separately, lazily, on
    // the first refresh — see ensureLyricsMessage.
    const nowPlaying = await this.sendNowPlayingMessage(channel, profile, snapshot);
    const queue = await channel.send(this.createQueueControlsPayload(profile, snapshot));

    await this.stateStore.save({
      guildId: profile.guildId,
      channelId,
      nowPlayingMessageId: nowPlaying.id,
      lyricsMessageId: null,
      queueMessageId: queue.id,
    });

    // Pinned here (not just in ensureGuildPanel) so a mid-session
    // recreation — triggered by any writePanel() call, not only the setup
    // flow — pins the fresh messages too, instead of leaving them unpinned
    // until someone happens to call ensureGuildPanel() again.
    await this.pinPanelMessage(nowPlaying, profile.guildId);
    await this.pinPanelMessage(queue, profile.guildId);

    return { channel, nowPlaying, queue };
  }

  private forgetLyricsMessage(guildId: string): void {
    this.lyricsMessageByGuild.delete(guildId);
    this.lyricsTrackKeyByGuild.delete(guildId);
  }

  private async pinPanelMessage(message: Message, guildId: string): Promise<void> {
    if (message.pinned) return;
    await message.pin("Persistent music control panel").catch((error: unknown) => {
      this.logger.warn({ error, guildId, messageId: message.id }, "Unable to pin music control panel message");
    });
  }

  // Backstop for the channel's whole reserved-for-panel purpose: deletes
  // anything found that isn't one of the two known-good panel messages.
  // Catches cases the targeted recovery paths above don't cover — a
  // transient status/queued-track card whose self-deletion timer (an
  // in-memory setTimeout, not persisted) never fired because the process
  // restarted first, a best-effort delete that failed silently, a stray
  // lyrics message left behind by ensureLyricsMessage's own delete failing,
  // or content from before the bot ever touched this channel. Deletes
  // regardless of author — this channel's whole point (see
  // ensureChannelPermissions) is to be reserved for the panel, so anything
  // else here shouldn't be either. Runs at panel setup (bot startup, and
  // whenever an admin reconfigures the control channel), not on a
  // recurring schedule — see ensureGuildPanel.
  private async sweepControlChannel(channel: TextChannel, keep: ReadonlySet<string>): Promise<void> {
    const messages = await channel.messages.fetch({ limit: channelSweepFetchLimit }).catch((error: unknown) => {
      this.logger.warn({ error, channelId: channel.id }, "Unable to fetch channel history for the control panel sweep");
      return null;
    });
    if (!messages) return;

    if (messages.size >= channelSweepFetchLimit) {
      this.logger.warn(
        { channelId: channel.id, limit: channelSweepFetchLimit },
        "Control panel channel sweep hit its fetch limit — there may be more stray messages left uninspected",
      );
    }

    for (const message of messages.values()) {
      if (keep.has(message.id)) continue;
      await message.delete().catch((error: unknown) => {
        this.logger.warn(
          { error, channelId: channel.id, messageId: message.id },
          "Unable to delete a stray message during the control panel channel sweep",
        );
      });
    }
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

  private async fetchExistingPair(
    channel: TextChannel,
    state: ControlPanelRuntimeState,
  ): Promise<{ nowPlaying: Message; queue: Message } | null> {
    if (!state.nowPlayingMessageId || !state.queueMessageId) return null;

    const [nowPlaying, queue] = await Promise.all([
      this.fetchPanelMessage(channel, state.nowPlayingMessageId),
      this.fetchPanelMessage(channel, state.queueMessageId),
    ]);
    const botId = this.client.user?.id;
    if (nowPlaying && queue && nowPlaying.author.id === botId && queue.author.id === botId) {
      return { nowPlaying, queue };
    }
    return null;
  }

  private async deletePanelMessagesBestEffort(
    channel: TextChannel,
    state: ControlPanelRuntimeState,
  ): Promise<void> {
    for (const messageId of [state.nowPlayingMessageId, state.queueMessageId]) {
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

  private async deleteObsoletePanelMessages(
    guildId: string,
    state: ControlPanelRuntimeState,
  ): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    const oldChannel = await guild?.channels.fetch(state.channelId).catch(() => null);
    if (!oldChannel?.isTextBased() || oldChannel.isDMBased()) return;

    if (guild && oldChannel.type === ChannelType.GuildText) {
      await this.restoreChannelPermissions(oldChannel, guild);
    }

    // lyricsMessageId here is best-effort/non-authoritative (see
    // ensureLyricsMessage) but still worth attempting — this old channel
    // never gets a sweepControlChannel pass, so this is the only chance to
    // clean up its lyrics message.
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
    const text = texts[profile.language];
    const embed = this.createNowPlayingEmbed(profile, snapshot);
    // Kept to what someone needs in the moment; what the buttons do lives in
    // /help, so the panel doesn't have to explain it.
    const hint = text.music.panel.hint;
    const lines = [
      hint.request,
      ...(profile.music.openQueueRequestsEnabled ? [] : [hint.controllersOnly]),
      hint.help,
    ];

    return {
      content: lines.join("\n"),
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
    const text = texts[profile.language];
    const embed = new EmbedBuilder().setColor(profile.embedColor as `#${string}`);
    if (!snapshot?.currentTrack) {
      embed
        .setTitle(`${this.musicDiscIcon(snapshot)} ${text.music.panel.nowPlaying.idleTitle}`)
        .setDescription(text.music.panel.nowPlaying.idleDescription);
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
    const requester = this.formatRequester(track.requestedByUserId, text);
    embed
      .setTitle(`${this.musicDiscIcon(snapshot)} ${snapshot.paused ? text.music.panel.nowPlaying.titlePaused : text.music.panel.nowPlaying.titlePlaying}`)
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
    const text = texts[profile.language];
    const embed = new EmbedBuilder()
      .setColor(profile.embedColor as `#${string}`)
      .setTitle(text.music.panel.lyrics.title);
    if (!snapshot?.currentTrack) {
      return embed.setDescription(text.music.panel.lyrics.idle);
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
    if (snapshot.lyricsUnavailable) return embed.setDescription(text.music.panel.lyrics.notFound);
    if (snapshot.lyricsOutage === "retrying") return embed.setDescription(text.music.panel.lyrics.retrying);
    if (snapshot.lyricsOutage === "gave_up") return embed.setDescription(text.music.panel.lyrics.unreachable);
    return embed.setDescription(text.music.panel.lyrics.searching);
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
    const text = texts[profile.language];
    const embed = new EmbedBuilder().setColor(profile.embedColor as `#${string}`).setTitle(text.music.panel.queue.title);
    const tracks = this.playerGateway.getQueue(profile.guildId);
    const queueLength = snapshot?.queueLength ?? tracks.length;

    embed.setDescription(
      queueLength === 0
        ? text.music.panel.queue.empty
        : `${text.music.panel.queue.summary({ count: queueLength, duration: formatQueueDuration(sumTrackDurations(tracks)) })}\n${this.buildQueueLines(tracks, text)}`,
    );

    if (snapshot?.currentTrack) {
      const queueStatus = queueLength === 0 ? text.music.panel.queue.footerEmpty : text.music.panel.queue.footerCount({ count: queueLength });
      const autoQueueNote = snapshot.autoQueue && snapshot.autoQueueIssue
        ? `  •  ${text.music.panel.queue.autoqueueIssue}`
        : "";
      const loop = text.music.panel.queue.footerLoop({ mode: text.music.label.repeat[snapshot.repeatMode] });
      embed.setFooter({
        text: `🔊 ${snapshot.volume}%  •  ${queueStatus}  •  ${loop}${autoQueueNote}`,
      });
    }

    return embed;
  }

  // Capped at a handful of tracks (queueDisplayLimit) so the panel stays a
  // glanceable preview rather than a scrollable wall of text — the full
  // queue is always one `/queue show` away. Still char-budgeted underneath
  // that cap in case a handful of unusually long titles would blow past the
  // embed description's real limit on their own.
  private buildQueueLines(tracks: readonly MusicTrack[], text: Texts): string {
    const lines: string[] = [];
    let used = 0;
    let shown = 0;
    for (const track of tracks) {
      if (shown >= queueDisplayLimit) break;
      const line = formatQueueTrackLine(track, shown + 1, text.music.label.autoqueue);
      if (used + line.length + 1 > queueListCharBudget) break;
      lines.push(line);
      used += line.length + 1;
      shown += 1;
    }
    const remaining = tracks.length - shown;
    if (remaining > 0) lines.push(text.music.panel.queue.more({ count: remaining }));
    return lines.join("\n");
  }

  private formatRequester(requestedByUserId: string | null, text: Texts): string {
    if (!requestedByUserId) return "";
    if (requestedByUserId !== "autoqueue") {
      return `\n${text.music.panel.nowPlaying.requestedBy({ user: `<@${requestedByUserId}>` })}`;
    }

    const botUserId = this.client.user?.id;
    return botUserId
      ? `\n${text.music.panel.nowPlaying.requestedByAutoqueue({ user: `<@${botUserId}>` })}`
      : `\n${text.music.panel.nowPlaying.requestedByAutoqueueUnknownBot}`;
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
      : masterPanelRefreshIntervalMs;
    const delay = Math.min(masterPanelRefreshIntervalMs, lyricDelay);

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
