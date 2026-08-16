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
