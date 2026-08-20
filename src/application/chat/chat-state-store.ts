import type { ChatMemoryRecord, ProposedMemoryAction } from "./chat-provider.js";
import { chatMemoryLimits } from "./chat-memory-policy.js";

export interface ChatSessionExchange {
  user: { content: string; createdAt: number };
  assistant: { content: string; createdAt: number };
}

// What the store actually persists per action — the statement's embedding,
// computed by the caller (ChatConversationService) since it's a network
// call and stores stay dumb (mirrors EmbeddedGuildKnowledgeCandidate). Null
// for a "remove" action (no statement to embed) or when embeddings aren't
// configured or the embed call failed.
export interface EmbeddedMemoryAction extends ProposedMemoryAction {
  embedding: number[] | null;
}

export interface ChatStateSnapshot {
  exchanges: readonly ChatSessionExchange[];
  memories: readonly ChatMemoryRecord[];
}

export interface UserChatStateStore {
  initialize(): Promise<void>;
  // `channelId` scopes the recent-exchange transcript to this channel — a
  // user's short-term "what did we just say" history doesn't bleed across
  // channels. `chat_memories` (long-term, cross-channel) is unaffected.
  load(guildId: string, userId: string, channelId: string, now: number): Promise<ChatStateSnapshot>;
  // Returns the exchanges evicted by this write (see boundSessionExchanges)
  // so the caller can consolidate them into durable knowledge before they're
  // lost, rather than the store silently discarding them.
  commitSuccessfulExchange(input: {
    guildId: string;
    userId: string;
    channelId: string;
    userMessage: string;
    assistantMessage: string;
    actions: readonly EmbeddedMemoryAction[];
    now: number;
  }): Promise<{ droppedExchanges: readonly ChatSessionExchange[] }>;
  // Merges memory actions only — no session exchange is written. Used for
  // an ambient "react" turn: the model engaged (if only with an emoji) and
  // may have proposed memory-worthy facts, but there's no assistant reply
  // text to record as a session exchange.
  applyMemoryActions(input: {
    guildId: string;
    userId: string;
    channelId: string;
    actions: readonly EmbeddedMemoryAction[];
    now: number;
  }): Promise<void>;
  forgetMemory(guildId: string, userId: string, memoryId: string): Promise<boolean>;
  forgetAllMemories(guildId: string, userId: string): Promise<number>;
  // Per-user, per-guild preference for whether mention-chat system notes
  // (dropped-image warnings, "still working on your previous message", etc.)
  // are DMed to them. Defaults to true when never set.
  getDmNotesEnabled(guildId: string, userId: string): Promise<boolean>;
  setDmNotesEnabled(guildId: string, userId: string, enabled: boolean): Promise<void>;
}

// Transitional alias for adapters compiled against the first memory iteration.
export type ChatStateStore = UserChatStateStore;

// Reports what got evicted (both the count-cap slice and the char-budget
// shift) alongside what's kept, so a caller can consolidate the dropped
// exchanges into durable knowledge instead of losing them silently.
export function boundSessionExchanges(
  exchanges: readonly ChatSessionExchange[],
): { kept: ChatSessionExchange[]; dropped: ChatSessionExchange[] } {
  const all = [...exchanges];
  const kept = all.slice(-chatMemoryLimits.maxExchanges);
  const dropped = all.slice(0, all.length - kept.length);
  while (
    kept.length > 1 &&
    JSON.stringify(kept).length > chatMemoryLimits.maxSessionSerializedChars
  ) {
    dropped.push(kept.shift()!);
  }
  return { kept, dropped };
}
