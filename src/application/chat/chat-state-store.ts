import type { ChatMemoryRecord, ProposedMemoryAction } from "./chat-provider.js";
import { chatMemoryLimits } from "./chat-memory-policy.js";

export interface ChatSessionExchange {
  user: { content: string; createdAt: number };
  assistant: { content: string; createdAt: number };
}

export interface ChatStateSnapshot {
  exchanges: readonly ChatSessionExchange[];
  memories: readonly ChatMemoryRecord[];
}

export interface UserChatStateStore {
  initialize(): Promise<void>;
  load(guildId: string, userId: string, now: number): Promise<ChatStateSnapshot>;
  commitSuccessfulExchange(input: {
    guildId: string;
    userId: string;
    userMessage: string;
    assistantMessage: string;
    actions: readonly ProposedMemoryAction[];
    now: number;
  }): Promise<void>;
  // Merges memory actions only — no session exchange is written. Used for
  // an ambient "react" turn: the model engaged (if only with an emoji) and
  // may have proposed memory-worthy facts, but there's no assistant reply
  // text to record as a session exchange.
  applyMemoryActions(input: {
    guildId: string;
    userId: string;
    actions: readonly ProposedMemoryAction[];
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

export function boundSessionExchanges(
  exchanges: readonly ChatSessionExchange[],
): ChatSessionExchange[] {
  const bounded = [...exchanges].slice(-chatMemoryLimits.maxExchanges);
  while (
    bounded.length > 1 &&
    JSON.stringify(bounded).length > chatMemoryLimits.maxSessionSerializedChars
  ) {
    bounded.shift();
  }
  return bounded;
}
