import { exampleExchangeLimits } from "./example-exchange.js";
import type { ExampleExchange } from "./example-exchange.js";
import type { ChatHistoryMessage, ChatUser } from "./chat-provider.js";
import {
  bm25Score,
  buildBm25Corpus,
  buildRelevanceContext,
  selectByRelevance,
  type ScorableRecord,
} from "./memory-relevance.js";

export interface ExampleExchangeSelectionInput {
  records: readonly ExampleExchange[];
  currentUser: ChatUser;
  mentionedUsers: readonly ChatUser[];
  recentHistory: readonly ChatHistoryMessage[];
  message: string;
  now: number;
}

export interface ExampleExchangeSelector {
  select(input: ExampleExchangeSelectionInput): Promise<readonly ExampleExchange[]>;
}

// Examples have no real subject or update time — they're static per-guild
// content, not per-user records — so subjectId/updatedAt are neutral values
// that never trigger the subject/recency boosts in bm25Score. Only the
// lexical term match (tags + user + character) actually differentiates them.
//
// No embedding-based selector: examples.md is re-read and re-parsed on every
// turn (no persisted store, unlike guild knowledge), so there's nowhere to
// cache a per-example embedding — computing one via API call per example on
// every single chat message would be a latency/cost problem, not an
// optimization. BM25 over the admin-supplied `tags` plus the exchange text
// is cheap and, since tags exist specifically to aid retrieval, effective
// enough without it.
function toScorable(exchange: ExampleExchange): ScorableRecord {
  return { subjectId: "", topic: exchange.tags, slot: "", statement: `${exchange.user} ${exchange.character}`, updatedAt: 0 };
}

function exampleExchangePromptProjection(exchange: ExampleExchange): unknown {
  return exchange;
}

/** Sends every configured example every turn. Kept as an explicit opt-out for guilds with a small example set. */
export class FullExampleExchangeSelector implements ExampleExchangeSelector {
  public select(input: ExampleExchangeSelectionInput): Promise<readonly ExampleExchange[]> {
    return Promise.resolve(input.records);
  }
}

/**
 * Ranks example exchanges by BM25 lexical overlap (over tags + user text +
 * character text) with the current turn, then keeps as many as fit under a
 * char budget instead of injecting the full example set unconditionally.
 */
export class RelevantExampleExchangeSelector implements ExampleExchangeSelector {
  public select(input: ExampleExchangeSelectionInput): Promise<readonly ExampleExchange[]> {
    if (input.records.length === 0) return Promise.resolve(input.records);
    const context = buildRelevanceContext({
      message: input.message,
      recentHistory: input.recentHistory,
      subjectIds: new Set(),
      now: input.now,
    });
    const corpus = buildBm25Corpus(input.records.map(toScorable));
    const selected = selectByRelevance(
      input.records,
      (exchange) => bm25Score(corpus, context, toScorable(exchange)),
      exampleExchangeLimits.maxSerializedChars,
      exampleExchangePromptProjection,
    );
    return Promise.resolve(selected);
  }
}
