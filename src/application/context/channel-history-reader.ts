export interface ChannelHistoryMessage {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorDisplayName: string;
  content: string;
  createdAt: number;
}

export type ChannelHistoryFailureCode =
  | "channel_not_found"
  | "guild_mismatch"
  | "unsupported_channel"
  | "missing_view_permission"
  | "missing_history_permission"
  | "fetch_failed";

export type ChannelHistoryReadResult =
  | {
      ok: true;
      messages: readonly ChannelHistoryMessage[];
      oldestSeenMessageId: string | null;
      reachedBoundary: boolean;
    }
  | {
      ok: false;
      code: ChannelHistoryFailureCode;
      message: string;
    };

export interface ChannelHistoryReadRequest {
  guildId: string;
  channelId: string;
  boundaryMs: number;
  beforeMessageId: string | null;
  maxMessages: number;
  maxCharacters: number;
  maxCharactersPerMessage: number;
}

/** Discord-independent input port for reading a bounded channel-history batch. */
export interface ChannelHistoryReader {
  readBatch(request: ChannelHistoryReadRequest): Promise<ChannelHistoryReadResult>;
}
