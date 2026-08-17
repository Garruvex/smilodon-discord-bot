import type { EnqueueResult } from "../../domain/music/music-track.js";
import type { MusicTrack } from "../../domain/music/music-track.js";

export type MusicRepeatMode = "off" | "track" | "queue";

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
  previous(guildId: string): Promise<void>;
  changeVolume(guildId: string, delta: number, maximum: number): Promise<void>;
  setVolume(guildId: string, volume: number, maximum: number): Promise<void>;
  shuffle(guildId: string): Promise<void>;
  getQueue(guildId: string): readonly MusicTrack[];
  removeQueueTrack(guildId: string, position: number): Promise<MusicTrack>;
  clearQueue(guildId: string): Promise<number>;
  setRepeatMode(guildId: string, mode: MusicRepeatMode): Promise<void>;
  toggleAutoQueue(guildId: string): Promise<boolean>;
  toggleTwentyFourSeven(guildId: string): Promise<boolean>;
  handleBotVoiceDisconnect(guildId: string): Promise<void>;
  handleVoiceChannelOccupancy(guildId: string, humanMemberCount: number): void;
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
