import type { EnqueueResult } from "../../domain/music/music-track.js";
import type { MusicTrack, PlayHistoryEntry } from "../../domain/music/music-track.js";

export type MusicRepeatMode = "off" | "track" | "queue";
export type MusicFilterPreset =
  | "off"
  | "nightcore"
  | "vaporwave"
  | "bassboost"
  | "pop"
  | "eightD"
  | "karaoke"
  | "vibrato"
  | "tremolo";

export interface EnqueueRequest {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  query: string;
  requestedByUserId: string;
}

export interface MusicPlayerGateway {
  initialize(clientUser: { id: string; username: string }): Promise<void>;
  acceptDiscordGatewayPayload(payload: unknown): void;
  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;
  pause(guildId: string): Promise<void>;
  resume(guildId: string): Promise<void>;
  stop(guildId: string): Promise<void>;
  skip(guildId: string): Promise<void>;
  skipTo(guildId: string, position: number): Promise<MusicTrack>;
  previous(guildId: string): Promise<void>;
  changeVolume(guildId: string, delta: number, maximum: number): Promise<void>;
  setVolume(guildId: string, volume: number, maximum: number): Promise<void>;
  shuffle(guildId: string): Promise<void>;
  getQueue(guildId: string): readonly MusicTrack[];
  getPlayHistory(guildId: string): readonly PlayHistoryEntry[];
  removeQueueTrack(guildId: string, position: number): Promise<MusicTrack>;
  moveQueueTrack(guildId: string, from: number, to: number): Promise<MusicTrack>;
  clearQueue(guildId: string): Promise<number>;
  seek(guildId: string, positionMs: number): Promise<MusicTrack>;
  replay(guildId: string): Promise<MusicTrack>;
  setRepeatMode(guildId: string, mode: MusicRepeatMode): Promise<void>;
  setFilterPreset(guildId: string, preset: MusicFilterPreset): Promise<void>;
  toggleAutoQueue(guildId: string): Promise<boolean>;
  // Casts (or, when it's already the voter's pick, withdraws) a vote for
  // which autoqueue option plays next. Returns the voter's pick afterward,
  // or null once withdrawn.
  voteAutoQueue(guildId: string, userId: string, optionIndex: number): number | null;
  rerollAutoQueueVote(guildId: string): Promise<void>;
  toggleTwentyFourSeven(guildId: string): Promise<boolean>;
  toggleLyrics(guildId: string): Promise<boolean>;
  handleBotVoiceDisconnect(guildId: string): Promise<void>;
  // Verifies the invariant "bot's actual Discord voice channel === the
  // Lavalink player's recorded voice channel" and destroys the player (via
  // the same cleanup as handleBotVoiceDisconnect) if it no longer holds.
  // Returns true when a stale player was found and destroyed, false when
  // there is no player or it's still healthy.
  reconcileVoiceState(guildId: string): Promise<boolean>;
  handleVoiceChannelOccupancy(guildId: string, humanMemberCount: number): void;
  handleGuildRemoved(guildId: string): Promise<void>;
  hasPlayer(guildId: string): boolean;
  isPaused(guildId: string): boolean;
  getVoiceChannelId(guildId: string): string | null;
  getSnapshot(guildId: string): MusicPlayerSnapshot | null;
}

export interface AutoQueueVoteOption {
  title: string;
  author: string;
  uri: string;
  votes: number;
  // True when synced lyrics were found for this option ahead of time; null
  // while that lookup is still running.
  lyricsAvailable: boolean | null;
}

export type AutoQueueVoteSnapshot =
  | { status: "loading" }
  // `leadingIndex` is what plays if the track ended right now: most votes,
  // with ties (including nobody voting) going to the earlier option.
  | { status: "ready"; options: readonly AutoQueueVoteOption[]; leadingIndex: number };

export interface MusicPlayerSnapshot {
  guildId: string;
  voiceChannelId: string;
  paused: boolean;
  playing: boolean;
  volume: number;
  queueLength: number;
  previousTrackCount: number;
  repeatMode: MusicRepeatMode;
  autoQueue: boolean;
  // True when the last autoqueue lookup for this player failed or found no
  // unplayed recommendation, so the panel can surface it instead of leaving
  // the failure only in logs.
  autoQueueIssue: boolean;
  // The "what plays next" vote. Only present while autoqueue is on, a track
  // is playing and nothing is queued behind it, which is exactly when
  // autoqueue is about to pick the next track itself.
  autoQueueVote: AutoQueueVoteSnapshot | null;
  twentyFourSeven: boolean;
  // User-controlled toggle (panel button, like autoQueue/twentyFourSeven) for
  // whether the Lyrics panel message should exist at all. Defaults to false
  // (opt-in); the control panel skips creating/updating it until enabled.
  lyricsEnabled: boolean;
  // The synced lyric line for the current playback position, if the track
  // has synced lyrics available and the Lavalink node has the lyrics plugin
  // installed. Null while unknown (no line has arrived yet) or unavailable.
  currentLyricLine: string | null;
  // Every line due to start before the panel's next repaint, oldest first.
  // A single "next line" would silently skip lines during a fast section
  // (e.g. a rap verse can fire several lines within one repaint window), so
  // this windows on time instead. Only populated with our own LRCLIB-fetched
  // lines (see LavalinkPlayerGateway) — empty on the plugin-push fallback,
  // which only ever gives us one line at a time.
  upcomingLyricLines: readonly string[];
  // Time until the next synced line starts; absent for plugin-only lyrics.
  nextLyricLineInMs?: number | null;
  // True once the lyrics plugin has confirmed no synced lyrics exist for the
  // current track, so the panel can say so instead of just staying silent.
  lyricsUnavailable: boolean;
  currentTrack: {
    title: string;
    author: string;
    uri: string;
    artworkUrl: string | null;
    durationMs: number;
    positionMs: number;
    isStream: boolean;
    requestedByUserId: string | null;
  } | null;
}
