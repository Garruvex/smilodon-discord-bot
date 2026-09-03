import type { Logger } from "pino";

import { personaLoreLimits } from "./persona-lore-policy.js";
import type { PersonaLoreChunk } from "./persona-source.js";
import type { ChatHistoryMessage } from "./chat-provider.js";
import type { EmbeddingsClient } from "./embeddings-client.js";
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

export interface PersonaLoreSelectionInput {
  chunks: readonly PersonaLoreChunk[];
  recentHistory: readonly ChatHistoryMessage[];
  message: string;
  now: number;
  // Bounded projection of the Discord reply chain this turn is responding
  // to (and its overflow summary, if any) — folded into the retrieval
  // query's keywords so a generic reply like "what do you think?" can still
  // surface lore relevant to the message it's replying to, not just the
  // literal current text. See ChatConversationService.run.
  replyChain?: readonly { content: string }[];
  replyChainSummary?: string | null;
}

export interface PersonaLoreSelector {
  select(input: PersonaLoreSelectionInput): Promise<readonly PersonaLoreChunk[]>;
}

function toScorable(chunk: PersonaLoreChunk): ScorableRecord {
  return { subjectId: "", topic: chunk.heading, slot: "", statement: chunk.text, updatedAt: 0 };
}

function loreChunkPromptProjection(chunk: PersonaLoreChunk): unknown {
  return { heading: chunk.heading, text: chunk.text };
}

/**
 * Ranks a compiled personality bundle's lore chunks by BM25 lexical overlap
 * fused (via reciprocal rank fusion) with embedding cosine similarity — an
 * embedding-based signal is viable here, unlike RelevantExampleExchangeSelector's
 * BM25-only approach, because the compiled bundle already gives us a
 * persisted place to cache each chunk's embedding (see
 * persona-bundle-compiler.ts); there's no per-turn embedding cost beyond
 * embedding the current message once.
 */
export class RelevantPersonaLoreSelector implements PersonaLoreSelector {
  public constructor(
    private readonly embeddingsClient: EmbeddingsClient | null = null,
    private readonly logger: Logger | null = null,
    // See memory-relevance.ts's minRelevantCosineSimilarity doc comment —
    // its default is an uncalibrated starting point, not a value validated
    // against any specific embeddings provider's similarity distribution.
    // Exposed here (rather than hardcoded) so the composition root can
    // override it per deployment once real data justifies a different
    // number, without touching this selector's logic.
    private readonly minCosineSimilarity: number = minRelevantCosineSimilarity,
  ) {}

  public async select(input: PersonaLoreSelectionInput): Promise<readonly PersonaLoreChunk[]> {
    if (input.chunks.length === 0) return input.chunks;
    const replyContext = [
      ...(input.replyChain ?? []).map((hop) => ({ content: hop.content })),
      ...(input.replyChainSummary ? [{ content: input.replyChainSummary }] : []),
    ];
    const context = buildRelevanceContext({
      message: input.message,
      recentHistory: [...input.recentHistory, ...replyContext],
      subjectIds: new Set(),
      now: input.now,
    });
    const corpus = buildBm25Corpus(input.chunks.map(toScorable));
    const lexicalScores = new Map(
      input.chunks.map((chunk) => [chunk, bm25Score(corpus, context, toScorable(chunk))] as const),
    );
    const lexicalOrder = [...input.chunks].sort((a, b) => lexicalScores.get(b)! - lexicalScores.get(a)!);
    const rankings = [lexicalOrder];
    const cosineScores = new Map<PersonaLoreChunk, number>();
    if (this.embeddingsClient && input.chunks.some((chunk) => chunk.embedding)) {
      try {
        // A bounded projection of what this turn is actually responding to
        // — the literal current message alone can be nearly content-free
        // ("what do you think?"), so the direct reply-chain parent (the
        // message right above it) and the overflow summary ride along in
        // the same embedding call rather than being left to the lexical
        // signal alone. Deliberately NOT the whole reply chain — bounded to
        // just the direct parent, so a long thread doesn't dilute the query
        // embedding with turns unrelated to what's being asked right now.
        const directReplyMessage = input.replyChain?.at(-1)?.content ?? null;
        const embeddingQueryText = [input.message, directReplyMessage, input.replyChainSummary]
          .filter((text): text is string => Boolean(text && text.trim()))
          .join("\n");
        const queryEmbedding = await this.embeddingsClient.embed(embeddingQueryText);
        const compatible = input.chunks.filter((chunk) => chunk.embedding?.length === queryEmbedding.length);
        if (compatible.length > 0) {
          for (const chunk of compatible) cosineScores.set(chunk, cosineSimilarity(chunk.embedding!, queryEmbedding));
          const embeddingOrder = [...compatible].sort(
            (a, b) => cosineScores.get(b)! - cosineScores.get(a)!,
          );
          rankings.push(embeddingOrder);
        }
      } catch (error) {
        this.logger?.debug({ error }, "Embedding the current message failed; persona lore selection falling back to lexical-only ranking");
      }
    }
    // A chunk with zero lexical overlap AND no meaningfully similar
    // embedding has no actual relevance signal — RRF still gives it a small
    // positive score purely for being ranked somewhere, which would
    // otherwise let unrelated backstory fill the character budget on every
    // turn. `> 0` alone isn't a real bar for the embedding side — unrelated
    // vectors routinely score above 0 — so cosine similarity needs to clear
    // this.minCosineSimilarity, not just be positive.
    const relevant = input.chunks.filter(
      (chunk) => (lexicalScores.get(chunk) ?? 0) > 0 || (cosineScores.get(chunk) ?? 0) >= this.minCosineSimilarity,
    );
    if (relevant.length === 0) return [];
    const fusedScore = reciprocalRankFusion(rankings);
    return selectByRelevance(
      relevant,
      (chunk) => fusedScore.get(chunk) ?? 0,
      personaLoreLimits.maxSelectedChars,
      loreChunkPromptProjection,
    );
  }
}
