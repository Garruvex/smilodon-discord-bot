import { chatMemoryLimits, validateMemoryActions } from "./chat-memory-policy.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "./chat-provider.js";
import type { ChatStateStore } from "./chat-state-store.js";
import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import { validateGuildKnowledgeCandidates } from "./guild-knowledge-policy.js";
import type { GuildKnowledgeStore } from "./guild-knowledge-store.js";
import { FullGuildMemorySelector, type GuildMemorySelector } from "./guild-memory-selector.js";

export interface ChatConversationInput extends Omit<ChatRequest, "recentHistory" | "memories" | "guildKnowledge"> {
  guildId: string;
}

export class ChatStateCommitError extends Error {
  public constructor(cause: unknown) {
    super("The chat reply was delivered, but its state could not be persisted.", { cause });
    this.name = "ChatStateCommitError";
  }
}

export class ChatConversationService {
  private readonly queue = new KeyedSerialQueue();

  public constructor(
    private readonly provider: ChatProvider,
    private readonly stateStore: ChatStateStore,
    private readonly guildKnowledgeStore: GuildKnowledgeStore,
    private readonly guildMemorySelector: GuildMemorySelector = new FullGuildMemorySelector(),
  ) {}

  public run(
    input: ChatConversationInput,
    deliver: (response: ChatResponse) => Promise<string>,
  ): Promise<ChatResponse> {
    const key = `${input.guildId}:${input.currentUser.id}`;
    return this.queue.run(key, async () => {
      const now = Date.now();
      const [state, guildKnowledge] = await Promise.all([
        this.stateStore.load(input.guildId, input.currentUser.id, now),
        this.guildKnowledgeStore.loadConfirmed(input.guildId),
      ]);
      const recentHistory = state.exchanges.flatMap((exchange) => [
        { role: "user" as const, content: exchange.user.content },
        { role: "assistant" as const, content: exchange.assistant.content },
      ]);
      const selectedGuildKnowledge = await this.guildMemorySelector.select({
        records: guildKnowledge,
        currentUser: input.currentUser,
        mentionedUsers: input.mentionedUsers,
        recentHistory,
        message: input.message,
      });
      const response = await this.provider.reply({
        ...input,
        recentHistory,
        memories: state.memories,
        guildKnowledge: selectedGuildKnowledge,
      });
      const allowedSubjects = new Set([
        input.currentUser.id,
        ...input.mentionedUsers.map((user) => user.id),
      ]);
      const validatedResponse = {
        ...response,
        contextUsage: {
          guildKnowledgeRecords: selectedGuildKnowledge.length,
          guildKnowledgeChars: JSON.stringify(selectedGuildKnowledge).length,
        },
        userMemoryActions: validateMemoryActions(response.userMemoryActions, allowedSubjects),
        guildKnowledgeCandidates: validateGuildKnowledgeCandidates(
          response.guildKnowledgeCandidates,
          {
            guildId: input.guildId,
            currentUserId: input.currentUser.id,
            allowedMemberIds: allowedSubjects,
          },
        ),
      };
      const deliveredAssistantMessage = await deliver(validatedResponse);
      try {
        await this.stateStore.commitSuccessfulExchange({
          guildId: input.guildId,
          userId: input.currentUser.id,
          userMessage: input.message.slice(0, chatMemoryLimits.maxUserMessageChars),
          assistantMessage: deliveredAssistantMessage.slice(0, chatMemoryLimits.maxAssistantMessageChars),
          actions: validatedResponse.userMemoryActions,
          now,
        });
      } catch (error) {
        throw new ChatStateCommitError(error);
      }
      try {
        await this.guildKnowledgeStore.propose({
          guildId: input.guildId,
          assertedByUserId: input.currentUser.id,
          candidates: validatedResponse.guildKnowledgeCandidates,
          now,
        });
      } catch (error) {
        throw new ChatStateCommitError(error);
      }
      return validatedResponse;
    });
  }
}
