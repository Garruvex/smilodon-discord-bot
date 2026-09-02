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
  toggleTwentyFourSeven(guildId: string): Promise<boolean>;
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
  twentyFourSeven: boolean;
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
