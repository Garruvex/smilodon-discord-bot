import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import {
  LavalinkManager,
  type Player,
  type SearchResult,
  type Track,
  type UnresolvedSearchResult,
  type UnresolvedTrack,
  type VoicePacket,
  type VoiceServer,
  type VoiceState,
  type ChannelDeletePacket,
} from "lavalink-client";
import type { Logger } from "pino";

import {
  MusicAutoQueueRerollEmptyError,
  MusicAutoQueueRerollLimitError,
  MusicAutoQueueVoteClosedError,
  MusicAutoQueueVoteUnavailableError,
  MusicChannelAccessError,
  MusicPlayerNotFoundError,
  MusicSearchEmptyError,
} from "../../application/music/music-errors.js";
import type {
  AutoQueueVoteRerollMode,
  AutoQueueVoteSnapshot,
  EnqueueRequest,
  MusicFilterPreset,
  MusicRepeatMode,
  MusicPlayerGateway,
} from "../../application/music/music-player-gateway.js";
import type { LavalinkConfiguration } from "../../config/configuration.js";
import type { EnqueueResult, MusicTrack, PlayHistoryEntry } from "../../domain/music/music-track.js";
import type { MusicPlayerSnapshot } from "../../application/music/music-player-gateway.js";
import type { MusicEventBus, MusicStateChangedEvent } from "../../application/music/music-event-bus.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import { LavalinkAutoQueue, type AutoQueueOutcome } from "./lavalink-auto-queue.js";
import { cleanArtistName } from "../../domain/music/artist-name.js";
import { lookupSyncedLyrics, lyricsCacheIdentity, type SyncedLyricLine } from "../lyrics/synced-lyrics-client.js";
import { buildLyricsCacheKey, type LyricsCacheStore } from "../../application/lyrics/lyrics-cache-store.js";
import { MUSIC_LIMITS } from "../../config/guild-configuration-limits.js";

const playHistoryLimit = 20;

// Voting locks this long before the track ends, so the winner is settled
// (and shown) before it plays, and a last-second click can't race the
// track ending.
export const autoQueueVoteLockMs = 10_000;
// A vote that would get less than this much open time isn't worth posting
// a message for; autoqueue just picks on its own for that track.
export const autoQueueVoteMinimumMs = 30_000;
export const autoQueueVoteRerollLimit = 3;
// A one-option vote isn't a choice, so rerolls need at least this many.
const autoQueueVoteMinimumRerollOptions = 2;

// One "what plays after this track" vote. Keyed to the track it follows, so
// a track change naturally invalidates it instead of carrying stale options
// (or someone's old vote) over to the next song.
interface AutoQueueVoteState {
  sourceTrackKey: string;
  // "skipped": too little of the track was left to be worth a vote.
  status: "loading" | "ready" | "unavailable" | "skipped";
  candidates: (Track | UnresolvedTrack)[];
  votesByUserId: Map<string, number>;
  // Whether each option (by identifier) has synced lyrics; absent while
  // still being checked.
  lyricsAvailableById: Map<string, boolean>;
  rerollsUsed: number;
  lastRerolledByUserId: string | null;
}

// Most votes wins; ties, including nobody voting at all, go to the earlier
// option, so option 1 is always the default.
function leadingVoteIndex(state: AutoQueueVoteState): number {
  const tallies = state.candidates.map(() => 0);
  for (const index of state.votesByUserId.values()) tallies[index] = (tallies[index] ?? 0) + 1;
  let leading = 0;
  tallies.forEach((votes, index) => {
    if (votes > tallies[leading]!) leading = index;
  });
  return leading;
}

// What playback and the vote need from a lyrics lookup, without any
// provider detail. "unavailable" is inconclusive: a provider couldn't be
// asked, so it's neither shown nor cached as "no lyrics".
type LyricsResolution =
  | { readonly status: "found"; readonly lines: SyncedLyricLine[] }
  | { readonly status: "not_found" }
  | { readonly status: "unavailable"; readonly retryable: boolean };

interface SelectedLyricLines {
  readonly current: string | null;
  readonly upcoming: readonly string[];
  readonly nextLyricLineInMs: number | null;
}

// Wider than the panel's own repaint cadence (activePlaybackRefreshIntervalMs
// in control-channel-service.ts, 3s) on purpose: a single "next line" would
// silently skip lines during a fast section (rap verses can fire several
// lines within one repaint window), so this windows on time rather than
// line count. It's also the hedge against real-world edit latency — on a
// slow connection a render can land several seconds after it was computed
// (see editMs logging in control-channel-service.ts), and by then the
// actual current line may already be one of these "upcoming" ones rather
// than the single line that was bolded as "current" — a wide window means
// that's still visible somewhere in the block instead of silently absent.
const lyricsLookaheadMs = 10_000;

// Selecting "current" from the raw sampled position picks the line that was
// playing the instant we asked — but by the time that write actually reaches
// Discord and becomes visible, playback has moved on by roughly one edit's
// network round trip. Biasing the reference point forward by a typical
// round-trip estimate keeps both the displayed line and the scheduled next
// wake-up (nextLyricLineInMs is measured from this same biased point) closer
// to what's actually playing when the edit is seen, rather than what was
// playing when it was computed. Only while actively advancing — applying
// this while paused would pick a line that hasn't started yet, since nothing
// is moving to "catch up" to.
const editLatencyBiasMs = 500;

// `lines` is sorted ascending by timestamp. "current" is always just the
// single most recently started line, however long ago that was — no
// grouping of nearby lines. An earlier version tried to bundle rapid-fire
// lines (a rap burst) together for extra context, but gating "current" on a
// trailing window at all was the actual bug: most songs space lines several
// seconds apart, so it went blank for most of every gap between lines
// instead of just staying on the last one. Not worth the risk for a
// cosmetic nicety.
function selectLyricLines(
  lines: readonly SyncedLyricLine[],
  positionMs: number,
  paused: boolean,
): SelectedLyricLines {
  const renderPositionMs = positionMs + (paused ? 0 : editLatencyBiasMs);
  let current: string | null = null;
  const upcoming: string[] = [];
  let nextLyricLineInMs: number | null = null;
  for (const entry of lines) {
    if (entry.timestampMs > renderPositionMs) {
      if (nextLyricLineInMs === null) {
        // The very next line is always shown as a preview, however far off
        // it is — a long intro (or an instrumental break mid-song) can put
        // it well past the lookahead window below, and without this a track
        // whose lyrics are already fully resolved looked identical to one
        // that hadn't loaded at all, for however long that gap lasted.
        nextLyricLineInMs = entry.timestampMs - renderPositionMs;
        upcoming.push(entry.line);
        continue;
      }
      if (entry.timestampMs > renderPositionMs + lyricsLookaheadMs) break;
      upcoming.push(entry.line);
      continue;
    }
    current = entry.line;
  }
  return { current, upcoming, nextLyricLineInMs };
}

export class LavalinkPlayerGateway implements MusicPlayerGateway {
  private readonly manager: LavalinkManager;
  private readonly autoQueue = new LavalinkAutoQueue();
  private readonly emptyQueueTimers = new Map<string, NodeJS.Timeout>();
  private readonly emptyChannelTimers = new Map<string, NodeJS.Timeout>();
  private readonly autoQueueIssues = new Set<string>();
  private readonly autoQueueVotes = new Map<string, AutoQueueVoteState>();
  private readonly playHistoryByGuild = new Map<string, PlayHistoryEntry[]>();
  // Lines from the Lavalink lyrics plugin's push events (currently sourced
  // from YouTube only — lrcLib is disabled there in favor of our own fetch
  // below, which fixes a bug in the plugin's lrcLib integration).
  private readonly pluginLyricsByGuild = new Map<
    string,
    { line: string } | "not-found"
  >();
  // Synced lines fetched directly from LRCLIB, keyed off live playback
  // position ourselves rather than relying on plugin-pushed lines.
  private readonly customLyricsByGuild = new Map<string, SyncedLyricLine[] | "not-found">();
  // Which track's lyrics are currently represented in the two maps above.
  // Lavalink can emit a duplicate trackStart for the *same* track (a node
  // reconnect replaying it mid-session is a known cause) — without this,
  // that would wipe already-correct lyrics and restart the fetch, flashing
  // "Looking for lyrics…" mid-song for no real reason. Each trackStart gets a
  // fresh entry object, and a fetch only lands if its entry is still the
  // current one — comparing track ids alone would let a slow request from an
  // earlier play of the same track (A → B → A) overwrite the newer result.
  private readonly currentLyricsTrackByGuild = new Map<string, { readonly trackId: string }>();

  public constructor(
    private readonly client: Client,
    configuration: LavalinkConfiguration,
    private readonly logger: Logger,
    private readonly eventBus: MusicEventBus,
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
    private readonly lyricsCacheStore: LyricsCacheStore | null = null,
  ) {
    this.manager = new LavalinkManager({
      nodes: [
        {
          id: "primary",
          host: configuration.host,
          port: configuration.port,
          authorization: configuration.password,
          secure: configuration.secure,
        },
      ],
      sendToShard: (guildId, payload): void => {
        client.guilds.cache.get(guildId)?.shard.send(payload);
      },
      autoSkip: true,
      autoMove: true,
      autoSkipOnResolveError: true,
      playerOptions: {
        defaultSearchPlatform: "spsearch",
        clientBasedPositionUpdateInterval: 1_000,
        onDisconnect: {
          autoReconnect: false,
          destroyPlayer: true,
        },
        onEmptyQueue: {
          autoPlayFunction: async (player, lastTrack): Promise<void> => {
            if (!player.get<boolean>("autoQueue")) return;
            await this.enqueueAutoQueueNext(player, lastTrack);
          },
        },
      },
      queueOptions: {
        maxPreviousTracks: 25,
      },
    });

    this.manager.nodeManager.on("connect", (node) => {
      logger.info({ nodeId: node.id }, "Lavalink node connected");
    });

    this.manager.nodeManager.on("disconnect", (node, reason) => {
      logger.warn({ nodeId: node.id, reason }, "Lavalink node disconnected");
    });

    this.manager.nodeManager.on("error", (node, error) => {
      logger.error({ nodeId: node.id, error }, "Lavalink node error");
    });

    this.manager.on("trackError", (player, track, payload) => {
      logger.error(
        {
          guildId: player.guildId,
          trackTitle: track?.info.title,
          exception: payload.exception,
        },
        "Lavalink track exception",
      );
    });

    this.manager.on("trackStart", (player, track) => {
      this.clearTimer(this.emptyQueueTimers, player.guildId);
      this.autoQueueIssues.delete(player.guildId);
      if (track) this.recordPlayHistory(player.guildId, track);
      this.publishStateChange({ guildId: player.guildId, reason: "track_started" });
      // Per-guild subscription that persists across tracks; re-subscribing on
      // every track start is harmless and keeps this self-healing if the node
      // restarted the session. No-op (rejects quietly) if the lavalyrics
      // plugin isn't installed on the node.
      void player.subscribeLyrics().catch(() => undefined);
      if (track?.encoded) {
        const trackId = track.encoded;
        // A duplicate event for the track already represented in the lyrics
        // maps — nothing to redo.
        if (this.currentLyricsTrackByGuild.get(player.guildId)?.trackId === trackId) return;
        const lyricsRequest = { trackId };
        this.currentLyricsTrackByGuild.set(player.guildId, lyricsRequest);
        const isCurrentRequest = (): boolean =>
          this.currentLyricsTrackByGuild.get(player.guildId) === lyricsRequest
          && this.manager.getPlayer(player.guildId)?.queue.current?.encoded === trackId;
        this.pluginLyricsByGuild.delete(player.guildId);
        this.customLyricsByGuild.delete(player.guildId);
        this.resolveSyncedLyrics(track.info.title, track.info.author ?? "", track.info.duration)
          .then((resolution) => {
            // Guard against a stale response landing after the track changed.
            if (!isCurrentRequest()) return;
            this.customLyricsByGuild.set(
              player.guildId,
              resolution.status === "found" ? resolution.lines : "not-found",
            );
            // Without this, the panel only picks up freshly-loaded lyrics on
            // its next unrelated timer tick — up to a full
            // activePlaybackRefreshIntervalMs late, on top of however long
            // the LRCLIB fetch itself took, since the tick that just ran
            // (right after trackStart) had nothing to schedule from yet and
            // fell back to the default cadence.
            this.publishStateChange({ guildId: player.guildId, reason: "lyrics_loaded" });
          })
          .catch((error: unknown) => {
            this.logger.warn(
              { error, guildId: player.guildId, trackTitle: track.info.title },
              "Unable to fetch synced lyrics from LRCLIB",
            );
            // A failed fetch must still settle the state — otherwise the
            // panel is stuck on "Looking for lyrics…" for this track forever
            // instead of eventually showing "No lyrics found".
            if (isCurrentRequest()) {
              this.customLyricsByGuild.set(player.guildId, "not-found");
              this.publishStateChange({ guildId: player.guildId, reason: "lyrics_loaded" });
            }
          });
      } else {
        this.currentLyricsTrackByGuild.delete(player.guildId);
        this.pluginLyricsByGuild.delete(player.guildId);
        this.customLyricsByGuild.delete(player.guildId);
      }
    });

    this.manager.on("queueEnd", (player) => {
      this.publishStateChange({ guildId: player.guildId, reason: "queue_changed" });
      this.scheduleEmptyQueueAction(player.guildId);
    });

    this.manager.on("playerDestroy", (player) => {
      this.clearTimer(this.emptyQueueTimers, player.guildId);
      this.clearTimer(this.emptyChannelTimers, player.guildId);
      this.autoQueue.clear(player.guildId);
      this.autoQueueVotes.delete(player.guildId);
      this.autoQueueIssues.delete(player.guildId);
      this.currentLyricsTrackByGuild.delete(player.guildId);
      this.pluginLyricsByGuild.delete(player.guildId);
      this.customLyricsByGuild.delete(player.guildId);
      this.publishStateChange({ guildId: player.guildId, reason: "player_destroyed" });
    });

    // Lines arrive on their own schedule (driven by the node off real
    // playback position), one at a time — unlike the LRCLIB path, there's no
    // full line list to compute nextLyricLineInMs from, so the progress
    // timer has nothing to schedule an on-time wake-up around and falls back
    // to its default cadence. Without an explicit nudge here, a line landing
    // just after a tick fired would otherwise sit unseen for up to that full
    // interval plus whatever's already queued. publishStateChange goes
    // through the panel refresh coordinator's own debounce (see
    // panel-refresh-coordinator.ts), so a burst of lines doesn't turn into a
    // burst of edits.
    this.manager.on("LyricsLine", (player, _track, payload) => {
      this.pluginLyricsByGuild.set(player.guildId, { line: payload.line.line });
      this.logger.info(
        { guildId: player.guildId, line: payload.line.line },
        "Plugin (YouTube) lyrics line received",
      );
      this.publishStateChange({ guildId: player.guildId, reason: "lyrics_loaded" });
    });

    this.manager.on("LyricsNotFound", (player) => {
      this.pluginLyricsByGuild.set(player.guildId, "not-found");
      this.logger.info({ guildId: player.guildId }, "Plugin (YouTube) lyrics reported not found");
      this.publishStateChange({ guildId: player.guildId, reason: "lyrics_loaded" });
    });
  }

  // Checks the shared cross-instance cache before ever hitting a provider,
  // and populates it after a conclusive fetch (including a confirmed "no
  // lyrics" result) so the next server — this instance or another one
  // entirely — to play the same track never has to ask again. An
  // "unavailable" result is never cached: it only means a provider couldn't
  // be reached, not that the lyrics don't exist.
  //
  // Logged at info level (cache hit/miss, live-fetch duration) specifically
  // so a reported "lyrics took N seconds" can be checked against real
  // numbers instead of guessed at — this path is otherwise silent.
  private async resolveSyncedLyrics(
    trackName: string,
    artistName: string,
    durationMs?: number,
  ): Promise<LyricsResolution> {
    // Normalized the same way the lookup normalizes for searching
    // (stripping "(Official Music Video)"-style suffixes and an
    // "Artist - Title" prefix) — otherwise every differently-titled
    // re-upload of the same song (a common YouTube reality) gets its own
    // cache entry instead of sharing the one already resolved for it.
    const identity = lyricsCacheIdentity(trackName, artistName);
    const trackKey = buildLyricsCacheKey(identity.title, identity.artist, durationMs);
    if (this.lyricsCacheStore) {
      const cached = await this.lyricsCacheStore.get(trackKey).catch((error: unknown) => {
        this.logger.warn({ error, trackKey }, "Unable to read the lyrics cache");
        return undefined;
      });
      if (cached !== undefined) {
        this.logger.info({ trackKey, cacheHit: true, found: cached !== null }, "Lyrics resolved from cache");
        return cached === null ? { status: "not_found" } : { status: "found", lines: [...cached] };
      }
    }

    const startedAt = Date.now();
    const { result } = await lookupSyncedLyrics(trackName, artistName, durationMs);
    this.logger.info(
      {
        trackKey,
        cacheHit: false,
        status: result.status,
        lineCount: result.status === "found" ? result.lines.length : 0,
        fetchMs: Date.now() - startedAt,
      },
      "Lyrics resolved from providers",
    );
    if (result.status === "unavailable") return { status: "unavailable", retryable: result.retryable };
    if (this.lyricsCacheStore) {
      const lines = result.status === "found" ? result.lines : null;
      void this.lyricsCacheStore.set(trackKey, lines).catch((error: unknown) => {
        this.logger.warn({ error, trackKey }, "Unable to write the lyrics cache");
      });
    }
    return result.status === "found" ? { status: "found", lines: result.lines } : { status: "not_found" };
  }

  public async initialize(clientUser: { id: string; username: string }): Promise<void> {
    await this.manager.init(clientUser);
  }

  public acceptDiscordGatewayPayload(payload: unknown): void {
    if (this.manager.initiated) {
      void this.manager.sendRawData(
        payload as VoicePacket | VoiceServer | VoiceState | ChannelDeletePacket,
      );
    }
  }

  public async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    const existingPlayer = this.manager.getPlayer(request.guildId);
    // Only a fresh join needs this — assertSameVoiceChannel (PlaybackService)
    // already guarantees an existing player's channel can't change here, so
    // the bot is necessarily already connected to request.voiceChannelId in
    // that case.
    if (!existingPlayer) {
      this.assertBotCanJoinVoiceChannel(request.guildId, request.voiceChannelId);
    }
    const player = this.manager.createPlayer({
      guildId: request.guildId,
      voiceChannelId: request.voiceChannelId,
      textChannelId: request.textChannelId,
      selfDeaf: true,
    });

    await player.connect();
    await this.prepareStageChannel(request.guildId);
    if (!existingPlayer) {
      const profile = this.guildConfigurationProvider.find(request.guildId);
      if (profile) await player.setVolume(profile.music.defaultVolume);
    }

    const searchResult = await this.searchWithFallback(player, request.query, {
      userId: request.requestedByUserId,
    });
    const tracks = searchResult.tracks;

    if (tracks.length === 0) {
      if (!player.queue.current) {
        await player.destroy("Search returned no playable tracks");
      }
      throw new MusicSearchEmptyError();
    }

    const selectedTracks = searchResult.loadType === "playlist"
      ? tracks
      : [tracks[0] as Track | UnresolvedTrack];
    const firstTrack = selectedTracks[0];

    if (!firstTrack) {
      throw new MusicSearchEmptyError();
    }

    for (const track of selectedTracks) {
      track.userData = {
        ...track.userData,
        requestedByUserId: request.requestedByUserId,
      };
    }

    await player.queue.add(selectedTracks);

    const startedPlayback = !player.playing && !player.paused;
    const queuePosition = startedPlayback
      ? null
      : Math.max(1, player.queue.tracks.length - selectedTracks.length + 1);
    if (startedPlayback) {
      await player.play();
    }

    this.publishStateChange({ guildId: request.guildId, reason: "queue_changed" });

    return {
      firstTrack: this.toMusicTrack(firstTrack, request.requestedByUserId),
      addedTrackCount: selectedTracks.length,
      startedPlayback,
      queuePosition,
    };
  }

  private async searchWithFallback(
    player: Player,
    query: string,
    requester: { userId: string },
  ): Promise<SearchResult | UnresolvedSearchResult> {
    try {
      const primary = await player.search({ query, source: "spsearch" }, requester);
      if (primary.tracks.length > 0) return primary;
    } catch (error) {
      this.logger.warn({ error, query }, "Spotify search failed, falling back to YouTube");
    }

    return player.search({ query, source: "ytsearch" }, requester);
  }

  public async pause(guildId: string): Promise<void> {
    await this.requirePlayer(guildId).pause();
    this.publishStateChange({ guildId, reason: "paused" });
  }

  public async resume(guildId: string): Promise<void> {
    await this.requirePlayer(guildId).resume();
    this.publishStateChange({ guildId, reason: "resumed" });
  }

  public async stop(guildId: string): Promise<void> {
    await this.requirePlayer(guildId).destroy("Stopped by a user");
    this.publishStateChange({ guildId, reason: "stopped" });
  }

  public async skip(guildId: string): Promise<void> {
    const player = this.requirePlayer(guildId);
    const currentTrack = player.queue.current;
    if (
      currentTrack &&
      player.get<boolean>("autoQueue") &&
      player.queue.tracks.length === 0
    ) {
      await this.enqueueAutoQueueNext(player, currentTrack);
    }
    await player.skip();
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  public async skipTo(guildId: string, position: number): Promise<MusicTrack> {
    const player = this.requirePlayer(guildId);
    const index = position - 1;
    const track = player.queue.tracks[index];
    if (!track) throw new MusicSearchEmptyError();
    await player.skip(index, true);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return this.toMusicTrack(
      track,
      typeof track.userData?.requestedByUserId === "string"
        ? track.userData.requestedByUserId
        : "unknown",
    );
  }

  // Closes the vote for `sourceTrack` and queues its winner. When no ready
  // vote exists (options still loading, the lookup failed, or autoqueue was
  // only just turned on) this is plain autoqueue: a fresh lookup whose first
  // result is queued.
  private async enqueueAutoQueueNext(
    player: Player,
    sourceTrack: Track | UnresolvedTrack,
  ): Promise<void> {
    const vote = this.autoQueueVotes.get(player.guildId);
    this.autoQueueVotes.delete(player.guildId);
    let outcome: AutoQueueOutcome | null = null;
    if (
      vote?.status === "ready" &&
      vote.sourceTrackKey === this.trackKey(sourceTrack) &&
      this.isAutoQueueVoteEnabled(player.guildId)
    ) {
      const winner = vote.candidates[leadingVoteIndex(vote)]!;
      outcome = await this.autoQueue.enqueue(player, winner);
      if (outcome.status !== "queued") {
        this.logger.warn(
          { guildId: player.guildId, error: outcome.status === "failed" ? outcome.error : undefined },
          "Unable to queue the autoqueue vote winner; falling back to a fresh lookup",
        );
        outcome = null;
      }
    }
    outcome ??= await this.autoQueue.enqueueNext(player, sourceTrack);
    this.logAutoQueueOutcome(player, sourceTrack, outcome);
  }

  // Missing configuration (never the case for a live guild) falls back to
  // the settings' defaults.
  private autoQueueVoteOptionCount(guildId: string): number {
    return this.guildConfigurationProvider.find(guildId)?.music.autoQueueVoteOptionCount
      ?? MUSIC_LIMITS.autoQueueVoteOptionCount.default;
  }

  private isAutoQueueVoteEnabled(guildId: string): boolean {
    return this.guildConfigurationProvider.find(guildId)?.music.autoQueueVoteEnabled ?? true;
  }

  // Keeps the vote in step with the player: opens one (fetching options in
  // the background) once a track is playing with autoqueue and the vote
  // setting on and nothing queued behind it, and drops it when its track is
  // no longer current. Run on every state change so no individual mutation
  // has to remember to. A vote survives someone queueing a track by hand
  // (it's just hidden from the snapshot), so removing that track again
  // brings back the same options and votes.
  private syncAutoQueueVote(guildId: string): void {
    const player = this.manager.getPlayer(guildId);
    const current = player?.queue.current;
    if (!player || !current || !player.get<boolean>("autoQueue") || !this.isAutoQueueVoteEnabled(guildId)) {
      this.autoQueueVotes.delete(guildId);
      return;
    }
    const sourceTrackKey = this.trackKey(current);
    if (this.autoQueueVotes.get(guildId)?.sourceTrackKey === sourceTrackKey) return;
    this.autoQueueVotes.delete(guildId);
    if (player.queue.tracks.length > 0) return;

    const remainingMs = this.remainingTrackMs(player);
    const vote: AutoQueueVoteState = {
      sourceTrackKey,
      status: remainingMs !== null && remainingMs < autoQueueVoteMinimumMs ? "skipped" : "loading",
      candidates: [],
      votesByUserId: new Map(),
      lyricsAvailableById: new Map(),
      rerollsUsed: 0,
      lastRerolledByUserId: null,
    };
    this.autoQueueVotes.set(guildId, vote);
    if (vote.status === "skipped") return;
    void this.autoQueue.findCandidates(player, current, this.autoQueueVoteOptionCount(guildId))
      .then((outcome) => {
        // Superseded (track changed, vote closed, or autoqueue turned off)
        // while the lookup was in flight.
        if (this.autoQueueVotes.get(guildId) !== vote) return;
        if (outcome.status === "found") {
          vote.status = "ready";
          vote.candidates = outcome.tracks;
          this.checkCandidateLyrics(guildId, vote);
        } else {
          vote.status = "unavailable";
          this.logger.warn(
            { guildId, trackTitle: current.info.title, error: outcome.status === "failed" ? outcome.error : undefined },
            "Unable to find autoqueue vote options",
          );
        }
        this.publishStateChange({ guildId, reason: "queue_changed" });
      })
      .catch((error: unknown) => {
        if (this.autoQueueVotes.get(guildId) === vote) vote.status = "unavailable";
        this.logger.warn({ error, guildId }, "Unable to find autoqueue vote options");
      });
  }

  // Only exposed while autoqueue is actually going to pick the next track:
  // with something queued, or a repeat mode on, the vote would never decide
  // anything.
  private getAutoQueueVoteSnapshot(player: Player): AutoQueueVoteSnapshot | null {
    const vote = this.autoQueueVotes.get(player.guildId);
    const current = player.queue.current;
    if (
      !vote ||
      !current ||
      vote.sourceTrackKey !== this.trackKey(current) ||
      player.queue.tracks.length > 0 ||
      player.repeatMode !== "off" ||
      !player.get<boolean>("autoQueue") ||
      !this.isAutoQueueVoteEnabled(player.guildId)
    ) return null;
    if (vote.status === "loading") return { status: "loading" };
    if (vote.status !== "ready") return null;
    const tallies = vote.candidates.map(() => 0);
    for (const index of vote.votesByUserId.values()) tallies[index] = (tallies[index] ?? 0) + 1;
    // Derived from playback position rather than a timer, so pausing
    // freezes the cutoff and seeking moves it for free. Streams have no end,
    // so they never lock; skip still closes them.
    const remainingMs = this.remainingTrackMs(player);
    return {
      status: "ready",
      locked: remainingMs !== null && remainingMs <= autoQueueVoteLockMs,
      closesInMs: remainingMs === null ? null : Math.max(0, remainingMs - autoQueueVoteLockMs),
      rerollsLeft: Math.max(0, autoQueueVoteRerollLimit - vote.rerollsUsed),
      lastRerolledByUserId: vote.lastRerolledByUserId,
      leadingIndex: leadingVoteIndex(vote),
      options: vote.candidates.map((track, index) => ({
        title: track.info.title,
        author: track.info.author ?? "Unknown artist",
        uri: track.info.uri ?? "",
        votes: tallies[index] ?? 0,
        lyricsAvailable: vote.lyricsAvailableById.get(this.autoQueue.identifier(track)) ?? null,
      })),
    };
  }

  private requireOpenAutoQueueVote(guildId: string): AutoQueueVoteState {
    const player = this.requirePlayer(guildId);
    const vote = this.autoQueueVotes.get(guildId);
    const snapshot = this.getAutoQueueVoteSnapshot(player);
    if (!vote || snapshot?.status !== "ready") throw new MusicAutoQueueVoteUnavailableError();
    if (snapshot.locked) throw new MusicAutoQueueVoteClosedError();
    return vote;
  }

  private remainingTrackMs(player: Player): number | null {
    const current = player.queue.current;
    const durationMs = current?.info.duration ?? 0;
    if (!current || current.info.isStream || durationMs <= 0) return null;
    return Math.max(0, durationMs - player.position);
  }

  public voteAutoQueue(guildId: string, userId: string, optionIndex: number): number | null {
    const vote = this.requireOpenAutoQueueVote(guildId);
    if (!vote.candidates[optionIndex]) throw new MusicAutoQueueVoteUnavailableError();
    const withdrawn = vote.votesByUserId.get(userId) === optionIndex;
    if (withdrawn) vote.votesByUserId.delete(userId);
    else vote.votesByUserId.set(userId, optionIndex);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return withdrawn ? null : optionIndex;
  }

  // Swaps in a fresh set of options (more like the current track, or more
  // by its artist), never repeating the ones being replaced. The old
  // options and their votes stay put if the lookup can't produce a real
  // choice, rather than leaving nothing to vote on. Capped per vote so one
  // listener can't keep cycling everyone's votes away; only rerolls that
  // actually change the options count toward the cap.
  public async rerollAutoQueueVote(
    guildId: string,
    userId: string,
    mode: AutoQueueVoteRerollMode,
  ): Promise<void> {
    const vote = this.requireOpenAutoQueueVote(guildId);
    if (vote.rerollsUsed >= autoQueueVoteRerollLimit) {
      throw new MusicAutoQueueRerollLimitError(autoQueueVoteRerollLimit);
    }
    const player = this.requirePlayer(guildId);
    const current = player.queue.current!;
    const replacing = vote.candidates.map((track) => this.autoQueue.identifier(track));
    const limit = this.autoQueueVoteOptionCount(guildId);
    const outcome = mode === "artist"
      ? await this.autoQueue.findArtistCandidates(player, current, limit, replacing)
      : await this.autoQueue.findCandidates(player, current, limit, replacing);
    if (this.autoQueueVotes.get(guildId) !== vote) throw new MusicAutoQueueVoteUnavailableError();
    if (outcome.status !== "found" || outcome.tracks.length < autoQueueVoteMinimumRerollOptions) {
      throw new MusicAutoQueueRerollEmptyError(mode === "artist" ? cleanArtistName(current.info.author ?? "") : null);
    }
    vote.candidates = outcome.tracks;
    vote.votesByUserId.clear();
    vote.rerollsUsed += 1;
    vote.lastRerolledByUserId = userId;
    this.checkCandidateLyrics(guildId, vote);
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  // Looks each option up the same way playback does, so the vote can mark
  // which ones have synced lyrics. It goes through the shared lyrics cache,
  // which also means the winner's lyrics are usually ready the moment it
  // starts. Only covers our own LRCLIB source: the YouTube plugin fallback
  // can't be asked ahead of time, so a missing mark means "none found in
  // advance", not "definitely none".
  private checkCandidateLyrics(guildId: string, vote: AutoQueueVoteState): void {
    for (const candidate of vote.candidates) {
      const identifier = this.autoQueue.identifier(candidate);
      if (vote.lyricsAvailableById.has(identifier)) continue;
      this.resolveSyncedLyrics(candidate.info.title, candidate.info.author ?? "", candidate.info.duration)
        .then((resolution) => {
          if (this.autoQueueVotes.get(guildId) !== vote) return;
          // An outage says nothing either way — leave the option unmarked.
          if (resolution.status === "unavailable") return;
          vote.lyricsAvailableById.set(identifier, resolution.status === "found");
          this.publishStateChange({ guildId, reason: "queue_changed" });
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { error, guildId, trackTitle: candidate.info.title },
            "Unable to check lyrics for an autoqueue vote option",
          );
        });
    }
  }

  private trackKey(track: Track | UnresolvedTrack): string {
    return track.encoded ?? this.autoQueue.identifier(track);
  }

  private logAutoQueueOutcome(
    player: Player,
    sourceTrack: Track | UnresolvedTrack,
    outcome: AutoQueueOutcome,
  ): void {
    if (outcome.status === "queued") {
      this.autoQueueIssues.delete(player.guildId);
      return;
    }
    this.autoQueueIssues.add(player.guildId);
    this.logger.warn(
      {
        guildId: player.guildId,
        trackTitle: sourceTrack.info.title,
        error: outcome.status === "failed" ? outcome.error : undefined,
      },
      outcome.status === "failed"
        ? "Autoqueue recommendation lookup failed"
        : "Autoqueue found no unplayed recommendation",
    );
  }

  public async previous(guildId: string): Promise<void> {
    const player = this.requirePlayer(guildId);
    const previousTrack = await player.queue.shiftPrevious();
    if (!previousTrack) throw new MusicPlayerNotFoundError();
    await player.play({ clientTrack: previousTrack });
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  public async changeVolume(
    guildId: string,
    delta: number,
    maximum: number,
  ): Promise<void> {
    const player = this.requirePlayer(guildId);
    await player.setVolume(Math.max(0, Math.min(maximum, player.volume + delta)));
    this.publishStateChange({ guildId, reason: "volume_changed" });
  }

  public async setVolume(guildId: string, volume: number, maximum: number): Promise<void> {
    await this.requirePlayer(guildId).setVolume(Math.max(0, Math.min(maximum, volume)));
    this.publishStateChange({ guildId, reason: "volume_changed" });
  }

  public async shuffle(guildId: string): Promise<void> {
    const player = this.requirePlayer(guildId);
    await player.queue.shuffle();
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  // Unlike mutating controls (pause/skip/etc.), a missing player isn't an
  // error for a read-only listing — it just means an empty queue, the same
  // outcome as a player that exists but has nothing queued. Every caller
  // (the panel, /queue show, the chat tool binding) can stay unconditional
  // this way instead of each needing its own "does a player even exist"
  // guard before asking what's queued.
  public getQueue(guildId: string): readonly MusicTrack[] {
    const player = this.manager.getPlayer(guildId);
    if (!player) return [];
    return player.queue.tracks.map((track) => this.toMusicTrack(
      track,
      typeof track.userData?.requestedByUserId === "string"
        ? track.userData.requestedByUserId
        : "unknown",
    ));
  }

  public getPlayHistory(guildId: string): readonly PlayHistoryEntry[] {
    return this.playHistoryByGuild.get(guildId) ?? [];
  }

  private recordPlayHistory(guildId: string, track: Track | UnresolvedTrack): void {
    const entry: PlayHistoryEntry = {
      ...this.toMusicTrack(
        track,
        typeof track.userData?.requestedByUserId === "string"
          ? track.userData.requestedByUserId
          : "unknown",
      ),
      playedAt: Date.now(),
    };
    const history = [entry, ...(this.playHistoryByGuild.get(guildId) ?? [])].slice(0, playHistoryLimit);
    this.playHistoryByGuild.set(guildId, history);
  }

  public async removeQueueTrack(guildId: string, position: number): Promise<MusicTrack> {
    const player = this.requirePlayer(guildId);
    const index = position - 1;
    const track = player.queue.tracks[index];
    if (!track) throw new MusicSearchEmptyError();
    await player.queue.remove(index);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return this.toMusicTrack(
      track,
      typeof track.userData?.requestedByUserId === "string"
        ? track.userData.requestedByUserId
        : "unknown",
    );
  }

  public async moveQueueTrack(guildId: string, from: number, to: number): Promise<MusicTrack> {
    const player = this.requirePlayer(guildId);
    const fromIndex = from - 1;
    const track = player.queue.tracks[fromIndex];
    if (!track) throw new MusicSearchEmptyError();
    const toIndex = Math.max(0, Math.min(to - 1, player.queue.tracks.length - 1));
    await player.queue.splice(fromIndex, 1);
    await player.queue.add(track, toIndex);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return this.toMusicTrack(
      track,
      typeof track.userData?.requestedByUserId === "string"
        ? track.userData.requestedByUserId
        : "unknown",
    );
  }

  public async seek(guildId: string, positionMs: number): Promise<MusicTrack> {
    const player = this.requirePlayer(guildId);
    const currentTrack = player.queue.current;
    if (!currentTrack) throw new MusicPlayerNotFoundError();
    const durationMs = currentTrack.info.duration;
    await player.seek(Math.max(0, Math.min(positionMs, durationMs)));
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return this.toMusicTrack(
      currentTrack,
      typeof currentTrack.userData?.requestedByUserId === "string"
        ? currentTrack.userData.requestedByUserId
        : "unknown",
    );
  }

  public async replay(guildId: string): Promise<MusicTrack> {
    const player = this.requirePlayer(guildId);
    const currentTrack = player.queue.current;
    if (!currentTrack) throw new MusicPlayerNotFoundError();
    await player.seek(0);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return this.toMusicTrack(
      currentTrack,
      typeof currentTrack.userData?.requestedByUserId === "string"
        ? currentTrack.userData.requestedByUserId
        : "unknown",
    );
  }

  public async clearQueue(guildId: string): Promise<number> {
    const player = this.requirePlayer(guildId);
    const count = player.queue.tracks.length;
    if (count > 0) await player.queue.remove(player.queue.tracks.slice());
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return count;
  }

  public async setRepeatMode(guildId: string, mode: MusicRepeatMode): Promise<void> {
    await this.requirePlayer(guildId).setRepeatMode(mode);
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  public async setFilterPreset(guildId: string, preset: MusicFilterPreset): Promise<void> {
    const player = this.requirePlayer(guildId);
    await player.filterManager.resetFilters();
    switch (preset) {
      case "off":
        break;
      case "nightcore":
        await player.filterManager.toggleNightcore();
        break;
      case "vaporwave":
        await player.filterManager.toggleVaporwave();
        break;
      case "bassboost":
        await player.filterManager.setEQPreset("BassboostMedium");
        break;
      case "pop":
        await player.filterManager.setEQPreset("Pop");
        break;
      case "eightD":
        await player.filterManager.toggleRotation();
        break;
      case "karaoke":
        await player.filterManager.toggleKaraoke();
        break;
      case "vibrato":
        await player.filterManager.toggleVibrato();
        break;
      case "tremolo":
        await player.filterManager.toggleTremolo();
        break;
    }
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  public toggleAutoQueue(guildId: string): Promise<boolean> {
    const player = this.requirePlayer(guildId);
    const enabled = !player.get<boolean>("autoQueue");
    player.set("autoQueue", enabled);
    if (!enabled) this.autoQueue.clear(guildId);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return Promise.resolve(enabled);
  }

  public toggleTwentyFourSeven(guildId: string): Promise<boolean> {
    const player = this.requirePlayer(guildId);
    const enabled = !player.get<boolean>("twentyFourSeven");
    player.set("twentyFourSeven", enabled);
    if (enabled) this.clearTimer(this.emptyQueueTimers, guildId);
    else if (!player.queue.current && player.queue.tracks.length === 0) {
      this.scheduleEmptyQueueAction(guildId);
    }
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return Promise.resolve(enabled);
  }

  public toggleLyrics(guildId: string): Promise<boolean> {
    const player = this.requirePlayer(guildId);
    const enabled = !(player.get<boolean>("lyricsEnabled") ?? false);
    player.set("lyricsEnabled", enabled);
    if (!enabled) this.pluginLyricsByGuild.delete(guildId);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return Promise.resolve(enabled);
  }

  public async handleBotVoiceDisconnect(guildId: string): Promise<void> {
    const player = this.manager.getPlayer(guildId);
    if (!player) return;
    this.clearTimer(this.emptyQueueTimers, guildId);
    this.clearTimer(this.emptyChannelTimers, guildId);
    await player.destroy("Bot was disconnected or moved from its voice channel");
  }

  public async reconcileVoiceState(guildId: string): Promise<boolean> {
    const player = this.manager.getPlayer(guildId);
    if (!player) return false;

    const guild = this.client.guilds.cache.get(guildId);
    // Without a cached guild there's no way to verify the bot's actual voice
    // state, so don't risk destroying a healthy player on a transient cache
    // gap — treat it as unverifiable rather than stale.
    if (!guild) return false;

    const actualVoiceChannelId = guild.members.me?.voice.channelId ?? null;
    if (actualVoiceChannelId === player.voiceChannelId) return false;

    await this.handleBotVoiceDisconnect(guildId);
    return true;
  }

  // Called when the bot leaves a guild, so per-guild timers/caches don't grow
  // unbounded across many join/leave cycles.
  public async handleGuildRemoved(guildId: string): Promise<void> {
    this.clearTimer(this.emptyQueueTimers, guildId);
    this.clearTimer(this.emptyChannelTimers, guildId);
    this.autoQueueIssues.delete(guildId);
    this.autoQueue.clear(guildId);
    this.autoQueueVotes.delete(guildId);
    this.playHistoryByGuild.delete(guildId);
    const player = this.manager.getPlayer(guildId);
    if (player) await player.destroy("Bot was removed from the guild");
  }

  public handleVoiceChannelOccupancy(guildId: string, humanMemberCount: number): void {
    const player = this.manager.getPlayer(guildId);
    if (!player) return;
    const profile = this.guildConfigurationProvider.find(guildId);
    if (!profile) return;

    if (humanMemberCount > 0) {
      this.clearTimer(this.emptyChannelTimers, guildId);
      if (profile.music.resumeWhenOccupied && player.get<boolean>("autoPaused")) {
        player.set("autoPaused", false);
        void player.resume();
      }
      return;
    }

    if (player.get<boolean>("twentyFourSeven") || profile.music.emptyChannelAction === "continue") return;
    this.clearTimer(this.emptyChannelTimers, guildId);
    const timer = setTimeout(() => {
      if (profile.music.emptyChannelAction === "pause") {
        player.set("autoPaused", true);
        void player.pause();
      } else {
        void player.destroy("Voice channel became empty");
      }
    }, profile.music.emptyChannelGracePeriodMs);
    timer.unref();
    this.emptyChannelTimers.set(guildId, timer);
  }

  public hasPlayer(guildId: string): boolean {
    return Boolean(this.manager.getPlayer(guildId));
  }

  public isPaused(guildId: string): boolean {
    return this.requirePlayer(guildId).paused;
  }

  public getVoiceChannelId(guildId: string): string | null {
    return this.manager.getPlayer(guildId)?.voiceChannelId ?? null;
  }

  public getSnapshot(guildId: string): MusicPlayerSnapshot | null {
    const player = this.manager.getPlayer(guildId);
    if (!player) return null;

    const current = player.queue.current;
    const requestedByUserId = current?.userData?.requestedByUserId;
    const customLyrics = this.customLyricsByGuild.get(guildId);
    const pluginLyrics = this.pluginLyricsByGuild.get(guildId);
    // Our own LRCLIB/NetEase fetch wins whenever it has something, since it
    // fixes a bug in the plugin's own lrcLib source (see
    // synced-lyrics-client.ts), and it's the only source with the full line
    // list needed to window upcoming lines. Fall back to the plugin's
    // push-based line (currently YouTube-sourced) otherwise — that one only
    // ever gives us the single current line, so there's no upcoming-lines
    // preview on that path.
    const { current: currentLyricLine, upcoming: upcomingLyricLines, nextLyricLineInMs } = Array.isArray(customLyrics)
      ? selectLyricLines(customLyrics, player.position, player.paused)
      : { current: typeof pluginLyrics === "object" ? pluginLyrics.line : null, upcoming: [], nextLyricLineInMs: null };
    // Our own fetch is authoritative and already gives a definitive answer
    // once it settles — waiting on the plugin fallback to *also* explicitly
    // confirm "not found" was the bug: that fallback only ever fires an
    // event when it actually attempts a lookup, and can stay silent forever
    // (no found, no not-found) if it never does. Once our source says
    // not-found, all that's left to check is whether the fallback found
    // something in the meantime — not whether it's also reached its own
    // definitive not-found state.
    const lyricsUnavailable = customLyrics === "not-found" && typeof pluginLyrics !== "object";

    return {
      guildId,
      voiceChannelId: player.voiceChannelId ?? "",
      paused: player.paused,
      playing: player.playing,
      volume: player.volume,
      queueLength: player.queue.tracks.length,
      previousTrackCount: player.queue.previous.length,
      repeatMode: player.repeatMode,
      autoQueue: player.get<boolean>("autoQueue") ?? false,
      autoQueueIssue: this.autoQueueIssues.has(guildId),
      autoQueueVote: this.getAutoQueueVoteSnapshot(player),
      twentyFourSeven: player.get<boolean>("twentyFourSeven") ?? false,
      lyricsEnabled: player.get<boolean>("lyricsEnabled") ?? false,
      currentLyricLine,
      upcomingLyricLines,
      nextLyricLineInMs,
      lyricsUnavailable,
      currentTrack: current
        ? {
            title: current.info.title,
            author: current.info.author ?? "Unknown artist",
            uri: current.info.uri ?? "",
            artworkUrl: current.info.artworkUrl ?? null,
            durationMs: current.info.duration ?? 0,
            positionMs: player.position,
            isStream: current.info.isStream ?? false,
            requestedByUserId:
              typeof requestedByUserId === "string" ? requestedByUserId : null,
          }
        : null,
    };
  }

  private requirePlayer(guildId: string): Player {
    const player = this.manager.getPlayer(guildId);
    if (!player) {
      throw new MusicPlayerNotFoundError();
    }

    return player;
  }

  private toMusicTrack(
    track: Track | UnresolvedTrack,
    requestedByUserId: string,
  ): MusicTrack {
    return {
      identifier: track.info.identifier ?? track.info.uri ?? track.info.title,
      title: track.info.title,
      author: track.info.author ?? "Unknown artist",
      uri: track.info.uri ?? "",
      artworkUrl: track.info.artworkUrl ?? null,
      durationMs: track.info.duration ?? 0,
      isStream: track.info.isStream ?? false,
      requestedByUserId,
    };
  }

  private publishStateChange(event: MusicStateChangedEvent): void {
    // A destroyed player can still be registered with the manager while its
    // destroy event fires, so it must not open a fresh vote.
    if (event.reason === "player_destroyed") this.autoQueueVotes.delete(event.guildId);
    else this.syncAutoQueueVote(event.guildId);
    void this.eventBus.publish(event).catch((error: unknown) => {
      this.logger.error({ error, event }, "Music state listener failed");
    });
  }

  private scheduleEmptyQueueAction(guildId: string): void {
    const player = this.manager.getPlayer(guildId);
    const profile = this.guildConfigurationProvider.find(guildId);
    if (
      !player ||
      !profile ||
      player.queue.current ||
      player.queue.tracks.length > 0 ||
      player.get<boolean>("twentyFourSeven")
    ) return;
    if (profile.music.emptyQueueAction === "stay_connected") return;
    this.clearTimer(this.emptyQueueTimers, guildId);
    const timer = setTimeout(() => {
      void this.manager.getPlayer(guildId)?.destroy("Queue remained empty");
    }, profile.music.emptyQueueDelayMs);
    timer.unref();
    this.emptyQueueTimers.set(guildId, timer);
  }

  private clearTimer(timers: Map<string, NodeJS.Timeout>, guildId: string): void {
    const timer = timers.get(guildId);
    if (timer) clearTimeout(timer);
    timers.delete(guildId);
  }

  // Gives a clear MusicChannelAccessError up front instead of a cryptic
  // voice-gateway timeout/failure once player.connect() is already underway
  // — matters most for /play's explicit `channel` option, which can target
  // any voice channel in the guild, not just one the invoker is standing in.
  private assertBotCanJoinVoiceChannel(guildId: string, voiceChannelId: string): void {
    const guild = this.client.guilds.cache.get(guildId);
    const me = guild?.members.me;
    const channel = guild?.channels.cache.get(voiceChannelId);
    if (!me || !channel?.isVoiceBased()) {
      throw new MusicChannelAccessError();
    }

    const permissions = channel.permissionsFor(me);
    const required = channel.type === ChannelType.GuildStageVoice
      ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
      : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
    if (!permissions?.has(required)) {
      throw new MusicChannelAccessError();
    }
  }

  private async prepareStageChannel(guildId: string): Promise<void> {
    const botVoiceState = this.client.guilds.cache.get(guildId)?.members.me?.voice;
    if (botVoiceState?.channel?.type !== ChannelType.GuildStageVoice) return;
    await botVoiceState.setRequestToSpeak(true).catch((error: unknown) => {
      this.logger.warn({ error, guildId }, "Unable to request speaker status in Stage channel");
    });
    await botVoiceState.setSuppressed(false).catch((error: unknown) => {
      this.logger.warn({ error, guildId }, "Unable to unsuppress bot in Stage channel");
    });
  }
}
