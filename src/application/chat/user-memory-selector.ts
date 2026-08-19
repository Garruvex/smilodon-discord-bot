import { chatMemoryLimits } from "./chat-memory-policy.js";
import type { ChatHistoryMessage, ChatMemoryRecord, ChatUser } from "./chat-provider.js";
import { buildRelevanceContext, scoreRecord, selectByRelevance } from "./memory-relevance.js";

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
    const selected = selectByRelevance(
      input.records,
      (record) => scoreRecord(context, {
        subjectId: record.subjectUserId,
        topic: record.topic,
        slot: record.slot,
        statement: record.statement,
        updatedAt: record.updatedAt,
      }),
      chatMemoryLimits.maxSelectedChars,
    );
    return Promise.resolve(selected);
  }
}
