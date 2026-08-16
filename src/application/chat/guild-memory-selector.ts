import type {
  ChatHistoryMessage,
  ChatUser,
  GuildKnowledgeRecord,
} from "./chat-provider.js";

export interface GuildMemorySelectionInput {
  records: readonly GuildKnowledgeRecord[];
  currentUser: ChatUser;
  mentionedUsers: readonly ChatUser[];
  recentHistory: readonly ChatHistoryMessage[];
  message: string;
}

export interface GuildMemorySelector {
  select(input: GuildMemorySelectionInput): Promise<readonly GuildKnowledgeRecord[]>;
}

/** Current one-round-trip strategy: use the store's already bounded record set. */
export class FullGuildMemorySelector implements GuildMemorySelector {
  public select(input: GuildMemorySelectionInput): Promise<readonly GuildKnowledgeRecord[]> {
    return Promise.resolve(input.records);
  }
}
