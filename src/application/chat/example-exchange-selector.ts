import type { Logger } from "pino";

import { exampleExchangeLimits } from "./example-exchange.js";
import type { ExampleExchange } from "./example-exchange.js";
import type { ChatHistoryMessage, ChatUser } from "./chat-provider.js";
import {
  bm25Score,
  buildBm25Corpus,
  buildEmbeddingQueryText,
  buildRelevanceContext,
  cosineSimilarity,
  minRelevantCosineSimilarity,
  reciprocalRankFusion,
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
  // Same role as PersonaLoreSelectionInput.replyChain — folded into the
  // lexical keywords, and its direct parent into the query embedding.
  replyChain?: readonly { content: string }[];
}

export interface ExampleExchangeSelector {
  select(input: ExampleExchangeSelectionInput): Promise<readonly ExampleExchange[]>;
}

// Examples have no real subject or update time — they're static per-guild
// content, not per-user records — so subjectId/updatedAt are neutral values
// that never trigger the subject/recency boosts in bm25Score. Only the
// situation side (tags + User line) is indexed, matching
// exampleExchangeEmbeddingText: the query is an incoming user message, so
// it's compared against what the example responds to, not the reply.
function toScorable(exchange: ExampleExchange): ScorableRecord {
  return { subjectId: "", topic: exchange.tags, slot: "", statement: exchange.user, updatedAt: 0 };
}

// Excludes `embedding` — a record loaded from a compiled bundle (see
// example-exchange-bundle.ts) carries a large float vector that's never
// sent to the model and would otherwise dominate the char-budget check.
function exampleExchangePromptProjection(exchange: ExampleExchange): unknown {
  return { tags: exchange.tags, user: exchange.user, character: exchange.character };
}

function isNearDuplicate(a: ExampleExchange, b: ExampleExchange): boolean {
  if (!a.embedding || !b.embedding) return false;
  return cosineSimilarity(a.embedding, b.embedding) >= exampleExchangeLimits.nearDuplicateSimilarity;
}

// Takes from `ranked` in order up to maxSelected, skipping near-duplicates of
// anything already chosen, then tops up to minSelected from `fallback`
// (file order). Both passes respect the serialized char budget.
function pickExamples(ranked: readonly ExampleExchange[], fallback: readonly ExampleExchange[]): ExampleExchange[] {
  const selected: ExampleExchange[] = [];
  let serializedChars = 0;
  const tryAdd = (candidate: ExampleExchange): void => {
    if (selected.includes(candidate) || selected.some((chosen) => isNearDuplicate(chosen, candidate))) return;
    const size = JSON.stringify(exampleExchangePromptProjection(candidate)).length;
    if (serializedChars + size > exampleExchangeLimits.maxSerializedChars) return;
    selected.push(candidate);
    serializedChars += size;
  };
  for (const candidate of ranked) {
    if (selected.length >= exampleExchangeLimits.maxSelected) break;
    tryAdd(candidate);
  }
  for (const candidate of fallback) {
    if (selected.length >= exampleExchangeLimits.minSelected) break;
    tryAdd(candidate);
  }
  return selected;
}

/** Sends every configured example every turn. Kept as an explicit opt-out for guilds with a small example set. */
export class FullExampleExchangeSelector implements ExampleExchangeSelector {
  public select(input: ExampleExchangeSelectionInput): Promise<readonly ExampleExchange[]> {
    return Promise.resolve(input.records);
  }
}

/**
 * Ranks example exchanges by BM25 lexical overlap (over tags + User line)
 * with the current turn, fused (via reciprocal rank fusion) with embedding
 * cosine similarity when the records carry embeddings — see
 * example-exchange-bundle.ts, which compiles those embeddings once at
 * upload time. Falls back to BM25-only when no embeddings client is
 * configured, records have no embeddings, or the per-turn embed call fails.
 *
 * Examples anchor voice rather than supply facts, so selection differs from
 * lore/memory: it's capped at a handful, skips near-duplicate situations,
 * and when too few examples are relevant it tops up from the start of
 * examples.md instead of sending none — an admin's first examples act as
 * the always-available voice baseline.
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
      recentHistory: [...input.recentHistory, ...(input.replyChain ?? [])],
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
        const queryEmbedding = await this.embeddingsClient.embed(buildEmbeddingQueryText({
          message: input.message,
          recentHistory: input.recentHistory,
          replyToContent: input.replyChain?.at(-1)?.content,
        }));
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
    // signal behind it, so it can't win a relevance slot — though it can
    // still be picked as part of the file-order baseline in pickExamples.
    const relevant = input.records.filter(
      (record) => (lexicalScores.get(record) ?? 0) > 0 || (cosineScores.get(record) ?? 0) >= this.minCosineSimilarity,
    );
    const fusedScore = reciprocalRankFusion(rankings);
    const ranked = [...relevant].sort((a, b) => (fusedScore.get(b) ?? 0) - (fusedScore.get(a) ?? 0));
    return pickExamples(ranked, input.records);
  }
}
