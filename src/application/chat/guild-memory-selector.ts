import { guildKnowledgeLimits } from "./guild-knowledge-policy.js";
import type {
  ChatHistoryMessage,
  ChatUser,
  GuildKnowledgeRecord,
} from "./chat-provider.js";
import { buildRelevanceContext, scoreRecord, selectByRelevance } from "./memory-relevance.js";

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
    );
    return Promise.resolve(selected);
  }
}
