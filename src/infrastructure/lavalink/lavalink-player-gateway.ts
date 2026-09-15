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
  MusicChannelAccessError,
  MusicPlayerNotFoundError,
  MusicSearchEmptyError,
} from "../../application/music/music-errors.js";
import type {
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
import { fetchSyncedLyrics, normalizeQuery, type SyncedLyricLine } from "../lyrics/lrclib-client.js";
import { buildLyricsCacheKey, type LyricsCacheStore } from "../../application/lyrics/lyrics-cache-store.js";

const playHistoryLimit = 20;

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
  // "Looking for lyrics…" mid-song for no real reason.
  private readonly currentLyricsTrackByGuild = new Map<string, string>();

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
            const outcome = await this.autoQueue.enqueueNext(player, lastTrack);
            this.logAutoQueueOutcome(player, lastTrack, outcome);
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
        if (this.currentLyricsTrackByGuild.get(player.guildId) === trackId) return;
        this.currentLyricsTrackByGuild.set(player.guildId, trackId);
        this.pluginLyricsByGuild.delete(player.guildId);
        this.customLyricsByGuild.delete(player.guildId);
        this.resolveSyncedLyrics(track.info.title, track.info.author ?? "", track.info.duration)
          .then((lines) => {
            // Guard against a stale response landing after the track changed.
            if (this.manager.getPlayer(player.guildId)?.queue.current?.encoded !== trackId) return;
            this.customLyricsByGuild.set(player.guildId, lines ?? "not-found");
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
            if (this.manager.getPlayer(player.guildId)?.queue.current?.encoded === trackId) {
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

  // Checks the shared cross-instance cache before ever hitting LRCLIB, and
  // populates it after a real fetch (including a confirmed "no lyrics"
  // result) so the next server — this instance or another one entirely —
  // to play the same track never has to ask LRCLIB again.
  //
  // Logged at info level (cache hit/miss, live-fetch duration) specifically
  // so a reported "lyrics took N seconds" can be checked against real
  // numbers instead of guessed at — this path is otherwise silent.
  private async resolveSyncedLyrics(
    trackName: string,
    artistName: string,
    durationMs?: number,
  ): Promise<SyncedLyricLine[] | null> {
    // Normalized the same way fetchSyncedLyrics normalizes for searching
    // (stripping "(Official Music Video)"-style suffixes and an
    // "Artist - Title" prefix) — otherwise every differently-titled
    // re-upload of the same song (a common YouTube reality) gets its own
    // cache entry instead of sharing the one already resolved for it.
    const normalized = normalizeQuery(trackName, artistName);
    const trackKey = buildLyricsCacheKey(normalized.title, artistName, durationMs);
    if (this.lyricsCacheStore) {
      const cached = await this.lyricsCacheStore.get(trackKey).catch((error: unknown) => {
        this.logger.warn({ error, trackKey }, "Unable to read the lyrics cache");
        return undefined;
      });
      if (cached !== undefined) {
        this.logger.info({ trackKey, cacheHit: true, found: cached !== null }, "Lyrics resolved from cache");
        return cached as SyncedLyricLine[] | null;
      }
    }

    const startedAt = Date.now();
    const lines = await fetchSyncedLyrics(trackName, artistName, durationMs);
    this.logger.info(
      { trackKey, cacheHit: false, found: lines !== null, lineCount: lines?.length ?? 0, fetchMs: Date.now() - startedAt },
      "Lyrics resolved from LRCLIB",
    );
    if (this.lyricsCacheStore) {
      void this.lyricsCacheStore.set(trackKey, lines).catch((error: unknown) => {
        this.logger.warn({ error, trackKey }, "Unable to write the lyrics cache");
      });
    }
    return lines;
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
      const outcome = await this.autoQueue.enqueueNext(player, currentTrack);
      this.logAutoQueueOutcome(player, currentTrack, outcome);
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
    // Our own LRCLIB fetch wins whenever it has something, since it fixes a
    // bug in the plugin's own lrcLib source (see lrclib-client.ts), and it's
    // the only source with the full line list needed to window upcoming
    // lines. Fall back to the plugin's push-based line (currently
    // YouTube-sourced) otherwise — that one only ever gives us the single
    // current line, so there's no upcoming-lines preview on that path.
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
