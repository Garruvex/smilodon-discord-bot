import { personaLoreLimits } from "./persona-lore-policy.js";
import type { PersonaLoreChunk } from "./persona-source.js";
import type { ChatHistoryMessage } from "./chat-provider.js";
import type { EmbeddingsClient } from "../../infrastructure/chat/openai-embeddings-client.js";
import {
  bm25Score,
  buildBm25Corpus,
  buildRelevanceContext,
  cosineSimilarity,
  reciprocalRankFusion,
  selectByRelevance,
  type ScorableRecord,
} from "./memory-relevance.js";

export interface PersonaLoreSelectionInput {
  chunks: readonly PersonaLoreChunk[];
  recentHistory: readonly ChatHistoryMessage[];
  message: string;
  now: number;
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
  public constructor(private readonly embeddingsClient: EmbeddingsClient | null = null) {}

  public async select(input: PersonaLoreSelectionInput): Promise<readonly PersonaLoreChunk[]> {
    if (input.chunks.length === 0) return input.chunks;
    const context = buildRelevanceContext({
      message: input.message,
      recentHistory: input.recentHistory,
      subjectIds: new Set(),
      now: input.now,
    });
    const corpus = buildBm25Corpus(input.chunks.map(toScorable));
    const lexicalOrder = [...input.chunks].sort(
      (a, b) => bm25Score(corpus, context, toScorable(b)) - bm25Score(corpus, context, toScorable(a)),
    );
    const rankings = [lexicalOrder];
    if (this.embeddingsClient) {
      try {
        const queryEmbedding = await this.embeddingsClient.embed(input.message);
        const embeddingOrder = [...input.chunks].sort(
          (a, b) => cosineSimilarity(b.embedding ?? [], queryEmbedding) - cosineSimilarity(a.embedding ?? [], queryEmbedding),
        );
        rankings.push(embeddingOrder);
      } catch {
        // Embedding the current message failed — fall back to lexical-only
        // ranking rather than failing the turn.
      }
    }
    const fusedScore = reciprocalRankFusion(rankings);
    return selectByRelevance(
      input.chunks,
      (chunk) => fusedScore.get(chunk) ?? 0,
      personaLoreLimits.maxSelectedChars,
      loreChunkPromptProjection,
    );
  }
}
