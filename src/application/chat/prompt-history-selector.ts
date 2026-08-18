import { chatMemoryLimits } from "./chat-memory-policy.js";
import type { ChatHistoryMessage } from "./chat-provider.js";
import type { ChatSessionExchange } from "./chat-state-store.js";

// Deliberately smaller than chatMemoryLimits (the session storage bound), since
// not every stored exchange needs to fit in every request's prompt. Derived
// from chatMemoryLimits rather than independent constants so the two budgets
// can't silently drift out of sync with each other.
export const promptHistoryLimits = {
  maxExchanges: Math.min(4, chatMemoryLimits.maxExchanges),
  maxSerializedChars: Math.min(6_000, chatMemoryLimits.maxSessionSerializedChars),
} as const;

export interface PromptHistorySelector {
  select(exchanges: readonly ChatSessionExchange[]): readonly ChatHistoryMessage[];
}

export class RecentPromptHistorySelector implements PromptHistorySelector {
  public select(exchanges: readonly ChatSessionExchange[]): readonly ChatHistoryMessage[] {
    const selected: ChatSessionExchange[] = [];
    for (const exchange of exchanges.slice(-promptHistoryLimits.maxExchanges).reverse()) {
      const candidate = [exchange, ...selected];
      if (JSON.stringify(candidate).length > promptHistoryLimits.maxSerializedChars) break;
      selected.unshift(exchange);
    }
    return selected.flatMap((exchange) => [
      { role: "user" as const, content: exchange.user.content },
      { role: "assistant" as const, content: exchange.assistant.content },
    ]);
  }
}
