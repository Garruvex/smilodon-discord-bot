import { guildKnowledgeLimits } from "./guild-knowledge-policy.js";
import type {
  ChatHistoryMessage,
  ChatUser,
  GuildKnowledgeRecord,
} from "./chat-provider.js";
import {
  bm25Score,
  buildBm25Corpus,
  buildRelevanceContext,
  cosineSimilarity,
  reciprocalRankFusion,
  selectByRelevance,
} from "./memory-relevance.js";
import type { EmbeddingsClient } from "./embeddings-client.js";

export interface GuildMemorySelectionInput {
  records: readonly GuildKnowledgeRecord[];
  currentUser: ChatUser;
  mentionedUsers: readonly ChatUser[];
  recentHistory: readonly ChatHistoryMessage[];
  message: string;
  now: number;
}

export interface GuildMemorySelector {
  select(input: GuildMemorySelectionInput): Promise<readonly GuildKnowledgeRecord[]>;
}

// Excludes `embedding` from the char-budget calculation — it's never sent to
// the model, so it must not count against maxSerializedChars.
function guildKnowledgePromptProjection(record: GuildKnowledgeRecord): unknown {
  return {
    id: record.id, subjectType: record.subjectType, subjectId: record.subjectId,
    topic: record.topic, slot: record.slot, statement: record.statement,
    source: record.source, updatedAt: record.updatedAt,
  };
}

/** Sends every confirmed guild-knowledge record every turn. Kept as an explicit opt-out for small/young guilds. */
export class FullGuildMemorySelector implements GuildMemorySelector {
  public select(input: GuildMemorySelectionInput): Promise<readonly GuildKnowledgeRecord[]> {
    return Promise.resolve(input.records);
  }
}

/**
 * Ranks confirmed guild knowledge by keyword overlap with the current turn,
 * a boost for records about someone actually in the conversation, and
 * recency — then keeps as many as fit under a char budget instead of
 * injecting the full confirmed set unconditionally.
 */
export class RelevantGuildMemorySelector implements GuildMemorySelector {
  public select(input: GuildMemorySelectionInput): Promise<readonly GuildKnowledgeRecord[]> {
    if (input.records.length === 0) return Promise.resolve(input.records);
    const subjectIds = new Set([input.currentUser.id, ...input.mentionedUsers.map((user) => user.id)]);
    const context = buildRelevanceContext({
      message: input.message,
      recentHistory: input.recentHistory,
      subjectIds,
      now: input.now,
    });
    const corpus = buildBm25Corpus(input.records);
    const selected = selectByRelevance(
      input.records,
      (record) => bm25Score(corpus, context, record),
      guildKnowledgeLimits.maxSerializedChars,
      guildKnowledgePromptProjection,
    );
    return Promise.resolve(selected);
  }
}

/**
 * Fuses two independently-ranked lists — BM25 lexical order and
 * cosine-similarity order between the record's stored embedding and the
 * current turn's embedded query — via Reciprocal Rank Fusion (see
 * reciprocalRankFusion), rather than adding the two scores directly (their
 * scales aren't comparable). A record with no stored embedding (pre-upgrade,
 * or a failed write-time embed) sorts to the bottom of the embedding
 * ranking, so it's still surfaced by BM25 order alone if lexically relevant.
 */
export class EmbeddingGuildMemorySelector implements GuildMemorySelector {
  public constructor(private readonly embeddingsClient: EmbeddingsClient) {}

  public async select(input: GuildMemorySelectionInput): Promise<readonly GuildKnowledgeRecord[]> {
    if (input.records.length === 0) return input.records;
    const subjectIds = new Set([input.currentUser.id, ...input.mentionedUsers.map((user) => user.id)]);
    const context = buildRelevanceContext({
      message: input.message,
      recentHistory: input.recentHistory,
      subjectIds,
      now: input.now,
    });
    const corpus = buildBm25Corpus(input.records);
    const lexicalOrder = [...input.records].sort(
      (a, b) => bm25Score(corpus, context, b) - bm25Score(corpus, context, a),
    );
    // A failed query embedding degrades to lexical-only ranking (RRF over a
    // single list is just that list's order) rather than failing the turn.
    const queryEmbedding = await this.embeddingsClient.embed(input.message).catch(() => null);
    const compatible = queryEmbedding
      ? input.records.filter((record) => record.embedding?.length === queryEmbedding.length)
      : [];
    const embeddingOrder = queryEmbedding && compatible.length > 0
      ? [...compatible].sort((a, b) =>
          cosineSimilarity(b.embedding!, queryEmbedding) - cosineSimilarity(a.embedding!, queryEmbedding))
      : null;
    const fused = reciprocalRankFusion(embeddingOrder ? [lexicalOrder, embeddingOrder] : [lexicalOrder]);
    const selected = selectByRelevance(
      input.records,
      (record) => fused.get(record) ?? 0,
      guildKnowledgeLimits.maxSerializedChars,
      guildKnowledgePromptProjection,
    );
    return selected;
  }
}
