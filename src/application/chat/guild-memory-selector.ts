import { guildKnowledgeLimits } from "./guild-knowledge-policy.js";
import type {
  ChatHistoryMessage,
  ChatUser,
  GuildKnowledgeRecord,
} from "./chat-provider.js";
import { buildRelevanceContext, cosineSimilarity, scoreRecord, selectByRelevance } from "./memory-relevance.js";
import type { EmbeddingsClient } from "../../infrastructure/chat/openai-embeddings-client.js";

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
    const selected = selectByRelevance(
      input.records,
      (record) => scoreRecord(context, record),
      guildKnowledgeLimits.maxSerializedChars,
      guildKnowledgePromptProjection,
    );
    return Promise.resolve(selected);
  }
}

// How much a cosine-similarity point of 1.0 (identical embeddings) is worth
// relative to the lexical scorer's terms — tuned so a strong semantic match
// with zero literal keyword overlap can still outrank a weak literal match,
// without letting similarity alone drown out the subject-ID boost (which
// should always win on a record about the exact person being discussed).
const similarityWeight = 4;

/**
 * Same ranking as RelevantGuildMemorySelector, plus a cosine-similarity term
 * between the record's stored embedding and the current turn's embedded
 * query — additive, not a replacement, so the subject/recency/keyword
 * signals still apply. A record with no stored embedding (pre-upgrade, or a
 * failed write-time embed) contributes 0 to the similarity term and is
 * ranked purely on the lexical score, same as RelevantGuildMemorySelector.
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
    // A failed query embedding degrades to the lexical-only score for every
    // record (queryEmbedding null) rather than failing the whole turn.
    const queryEmbedding = await this.embeddingsClient.embed(input.message).catch(() => null);
    const selected = selectByRelevance(
      input.records,
      (record) => {
        const lexicalScore = scoreRecord(context, record);
        if (!queryEmbedding || !record.embedding) return lexicalScore;
        return lexicalScore + similarityWeight * cosineSimilarity(record.embedding, queryEmbedding);
      },
      guildKnowledgeLimits.maxSerializedChars,
      guildKnowledgePromptProjection,
    );
    return selected;
  }
}
