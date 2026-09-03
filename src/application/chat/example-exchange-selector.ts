import type { Logger } from "pino";

import { exampleExchangeLimits } from "./example-exchange.js";
import type { ExampleExchange } from "./example-exchange.js";
import type { ChatHistoryMessage, ChatUser } from "./chat-provider.js";
import {
  bm25Score,
  buildBm25Corpus,
  buildRelevanceContext,
  cosineSimilarity,
  minRelevantCosineSimilarity,
  reciprocalRankFusion,
  selectByRelevance,
  type ScorableRecord,
} from "./memory-relevance.js";
import type { EmbeddingsClient } from "./embeddings-client.js";

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
function toScorable(exchange: ExampleExchange): ScorableRecord {
  return { subjectId: "", topic: exchange.tags, slot: "", statement: `${exchange.user} ${exchange.character}`, updatedAt: 0 };
}

// Excludes `embedding` — a record loaded from a compiled bundle (see
// example-exchange-bundle.ts) carries a large float vector that's never
// sent to the model and would otherwise dominate the char-budget check.
function exampleExchangePromptProjection(exchange: ExampleExchange): unknown {
  return { tags: exchange.tags, user: exchange.user, character: exchange.character };
}

/** Sends every configured example every turn. Kept as an explicit opt-out for guilds with a small example set. */
export class FullExampleExchangeSelector implements ExampleExchangeSelector {
  public select(input: ExampleExchangeSelectionInput): Promise<readonly ExampleExchange[]> {
    return Promise.resolve(input.records);
  }
}

/**
 * Ranks example exchanges by BM25 lexical overlap (over tags + user text +
 * character text) with the current turn, fused (via reciprocal rank fusion)
 * with embedding cosine similarity when the records carry embeddings — see
 * example-exchange-bundle.ts, which compiles those embeddings once at
 * upload time rather than per turn (the reason a plain BM25-only selector
 * was originally the only viable option here). Falls back to BM25-only when
 * no embeddings client is configured, records have no embeddings, or the
 * per-turn message embed call fails. Keeps as many exchanges as fit under a
 * char budget instead of injecting the full example set unconditionally.
 */
export class RelevantExampleExchangeSelector implements ExampleExchangeSelector {
  public constructor(
    private readonly embeddingsClient: EmbeddingsClient | null = null,
    private readonly logger: Logger | null = null,
    // See memory-relevance.ts's minRelevantCosineSimilarity doc comment and
    // RelevantPersonaLoreSelector's matching parameter — an uncalibrated
    // starting-point default, overridable per deployment without touching
    // this selector's logic.
    private readonly minCosineSimilarity: number = minRelevantCosineSimilarity,
  ) {}

  public async select(input: ExampleExchangeSelectionInput): Promise<readonly ExampleExchange[]> {
    if (input.records.length === 0) return input.records;
    const context = buildRelevanceContext({
      message: input.message,
      recentHistory: input.recentHistory,
      subjectIds: new Set(),
      now: input.now,
    });
    const corpus = buildBm25Corpus(input.records.map(toScorable));
    const lexicalScores = new Map(
      input.records.map((record) => [record, bm25Score(corpus, context, toScorable(record))] as const),
    );
    const lexicalOrder = [...input.records].sort((a, b) => lexicalScores.get(b)! - lexicalScores.get(a)!);
    const rankings = [lexicalOrder];
    const cosineScores = new Map<ExampleExchange, number>();
    if (this.embeddingsClient && input.records.some((record) => record.embedding)) {
      try {
        const queryEmbedding = await this.embeddingsClient.embed(input.message);
        const compatible = input.records.filter((record) => record.embedding?.length === queryEmbedding.length);
        if (compatible.length > 0) {
          for (const record of compatible) cosineScores.set(record, cosineSimilarity(record.embedding!, queryEmbedding));
          const embeddingOrder = [...compatible].sort((a, b) => cosineScores.get(b)! - cosineScores.get(a)!);
          rankings.push(embeddingOrder);
        }
      } catch (error) {
        this.logger?.debug({ error }, "Embedding the current message failed; example exchange selection falling back to lexical-only ranking");
      }
    }
    // Same relevance floor as RelevantPersonaLoreSelector: a record with no
    // lexical overlap and no meaningfully similar embedding has no actual
    // signal behind it — without this, RRF's small positive score for
    // merely being ranked somewhere let every example compete for the
    // char budget regardless of relevance.
    const relevant = input.records.filter(
      (record) => (lexicalScores.get(record) ?? 0) > 0 || (cosineScores.get(record) ?? 0) >= this.minCosineSimilarity,
    );
    if (relevant.length === 0) return [];
    const fusedScore = reciprocalRankFusion(rankings);
    return selectByRelevance(
      relevant,
      (exchange) => fusedScore.get(exchange) ?? 0,
      exampleExchangeLimits.maxSerializedChars,
      exampleExchangePromptProjection,
    );
  }
}
