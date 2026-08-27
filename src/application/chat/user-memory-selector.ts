import { chatMemoryLimits } from "./chat-memory-policy.js";
import type { ChatHistoryMessage, ChatMemoryRecord, ChatUser } from "./chat-provider.js";
import {
  bm25Score,
  buildBm25Corpus,
  buildRelevanceContext,
  cosineSimilarity,
  reciprocalRankFusion,
  selectByRelevance,
  type ScorableRecord,
} from "./memory-relevance.js";
import type { EmbeddingsClient } from "./embeddings-client.js";

export interface UserMemorySelectionInput {
  records: readonly ChatMemoryRecord[];
  currentUser: ChatUser;
  mentionedUsers: readonly ChatUser[];
  recentHistory: readonly ChatHistoryMessage[];
  message: string;
  now: number;
}

export interface UserMemorySelector {
  select(input: UserMemorySelectionInput): Promise<readonly ChatMemoryRecord[]>;
}

// Excludes `embedding` from the char-budget calculation — it's never sent to
// the model (buildChatContext pulls specific fields, not the whole record),
// so it must not count against maxSelectedChars. Same fix as
// guildKnowledgePromptProjection in guild-memory-selector.ts.
function userMemoryPromptProjection(record: ChatMemoryRecord): unknown {
  const { embedding: _embedding, ...rest } = record;
  return rest;
}

// ChatMemoryRecord's subject field is named subjectUserId, not subjectId —
// this adapts it to the shape memory-relevance.ts's BM25/scoring helpers
// expect. Built once per select() call, one wrapper per record, so identity
// stays stable for the Map-keyed corpus/fusion lookups below.
function toScorable(record: ChatMemoryRecord): ScorableRecord {
  return {
    subjectId: record.subjectUserId,
    topic: record.topic,
    slot: record.slot,
    statement: record.statement,
    updatedAt: record.updatedAt,
  };
}

/** Sends every stored memory every turn. Kept as an explicit opt-out for small/young guilds. */
export class FullUserMemorySelector implements UserMemorySelector {
  public select(input: UserMemorySelectionInput): Promise<readonly ChatMemoryRecord[]> {
    return Promise.resolve(input.records);
  }
}

/**
 * Ranks stored memories by keyword overlap with the current turn, a boost
 * for memories about someone actually in the conversation, and recency —
 * then keeps as many as fit under a char budget instead of injecting the
 * full stored set unconditionally.
 */
export class RelevantUserMemorySelector implements UserMemorySelector {
  public select(input: UserMemorySelectionInput): Promise<readonly ChatMemoryRecord[]> {
    if (input.records.length === 0) return Promise.resolve(input.records);
    const subjectIds = new Set([input.currentUser.id, ...input.mentionedUsers.map((user) => user.id)]);
    const context = buildRelevanceContext({
      message: input.message,
      recentHistory: input.recentHistory,
      subjectIds,
      now: input.now,
    });
    const scorableByRecord = new Map(input.records.map((record) => [record, toScorable(record)] as const));
    const corpus = buildBm25Corpus([...scorableByRecord.values()]);
    const selected = selectByRelevance(
      input.records,
      (record) => bm25Score(corpus, context, scorableByRecord.get(record)!),
      chatMemoryLimits.maxSelectedChars,
      userMemoryPromptProjection,
    );
    return Promise.resolve(selected);
  }
}

/**
 * Fuses two independently-ranked lists — BM25 lexical order and
 * cosine-similarity order between the record's stored embedding and the
 * current turn's embedded query — via Reciprocal Rank Fusion (see
 * reciprocalRankFusion in memory-relevance.ts), rather than adding the two
 * scores directly (their scales aren't comparable). A record with no stored
 * embedding (pre-upgrade, or a failed write-time embed) sorts to the bottom
 * of the embedding ranking, so it's still surfaced by BM25 order alone if
 * lexically relevant.
 */
export class EmbeddingUserMemorySelector implements UserMemorySelector {
  public constructor(private readonly embeddingsClient: EmbeddingsClient) {}

  public async select(input: UserMemorySelectionInput): Promise<readonly ChatMemoryRecord[]> {
    if (input.records.length === 0) return input.records;
    const subjectIds = new Set([input.currentUser.id, ...input.mentionedUsers.map((user) => user.id)]);
    const context = buildRelevanceContext({
      message: input.message,
      recentHistory: input.recentHistory,
      subjectIds,
      now: input.now,
    });
    const scorableByRecord = new Map(input.records.map((record) => [record, toScorable(record)] as const));
    const corpus = buildBm25Corpus([...scorableByRecord.values()]);
    const lexicalOrder = [...input.records].sort(
      (a, b) => bm25Score(corpus, context, scorableByRecord.get(b)!) - bm25Score(corpus, context, scorableByRecord.get(a)!),
    );
    // A failed query embedding degrades to lexical-only ranking (RRF over a
    // single list is just that list's order) rather than failing the turn.
    const queryEmbedding = await this.embeddingsClient.embed(input.message).catch(() => null);
    const embeddingOrder = queryEmbedding
      ? [...input.records].sort((a, b) =>
          cosineSimilarity(b.embedding ?? [], queryEmbedding) - cosineSimilarity(a.embedding ?? [], queryEmbedding))
      : lexicalOrder;
    const fused = reciprocalRankFusion([lexicalOrder, embeddingOrder]);
    const selected = selectByRelevance(
      input.records,
      (record) => fused.get(record) ?? 0,
      chatMemoryLimits.maxSelectedChars,
      userMemoryPromptProjection,
    );
    return selected;
  }
}
