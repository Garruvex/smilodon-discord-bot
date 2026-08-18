import { chatMemoryInstructions, chatMemoryLimits, validateMemoryActions } from "./chat-memory-policy.js";
import { chatSafetyGuard, type ChatProvider, type ChatRequest, type ChatResponse, type ChatResponseObserver } from "./chat-provider.js";
import type { ChatStateStore } from "./chat-state-store.js";
import type { UserCustomizationStore } from "./user-customization-store.js";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import { guildKnowledgeInstructions, validateGuildKnowledgeCandidates } from "./guild-knowledge-policy.js";
import type { GuildKnowledgeStore } from "./guild-knowledge-store.js";
import { FullGuildMemorySelector, type GuildMemorySelector } from "./guild-memory-selector.js";
import { RecentPromptHistorySelector, type PromptHistorySelector } from "./prompt-history-selector.js";

export interface ChatConversationInput
  extends Omit<ChatRequest, "recentHistory" | "memories" | "guildKnowledge" | "userCustomization"> {
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
    private readonly promptHistorySelector: PromptHistorySelector = new RecentPromptHistorySelector(),
    private readonly userCustomizationStore: UserCustomizationStore | null = null,
  ) {}

  // True while a previous request from this same guild+user is still being
  // processed (or queued behind one that is), so callers can tell the user
  // their new message will be handled after the current one instead of
  // appearing to hang silently.
  public isBusy(guildId: string, userId: string): boolean {
    return this.queue.isBusy(`${guildId}:${userId}`);
  }

  public getDmNotesEnabled(guildId: string, userId: string): Promise<boolean> {
    return this.stateStore.getDmNotesEnabled(guildId, userId);
  }

  public run(
    input: ChatConversationInput,
    deliver: (response: ChatResponse) => Promise<string>,
    observer?: ChatResponseObserver,
  ): Promise<ChatResponse> {
    const key = `${input.guildId}:${input.currentUser.id}`;
    return this.queue.run(key, async () => {
      const now = Date.now();
      const [state, guildKnowledge, userCustomization] = await Promise.all([
        this.stateStore.load(input.guildId, input.currentUser.id, now),
        this.guildKnowledgeStore.loadConfirmed(input.guildId),
        this.userCustomizationStore?.load(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
      ]);
      const recentHistory = this.promptHistorySelector.select(state.exchanges);
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
        userCustomization,
      }, observer);
      const allowedSubjects = new Set([
        input.currentUser.id,
        ...input.mentionedUsers.map((user) => user.id),
      ]);
      const validatedResponse = {
        ...response,
        contextUsage: {
          personalityChars: input.personality.length,
          userCustomizationChars: userCustomization?.length ?? 0,
          securityInstructionChars: chatSafetyGuard.length,
          memoryInstructionChars: chatMemoryInstructions.length + guildKnowledgeInstructions.length,
          historyMessages: recentHistory.length,
          historyChars: JSON.stringify(recentHistory).length,
          memoryRecords: state.memories.length,
          memoryChars: JSON.stringify(state.memories).length,
          guildKnowledgeRecords: selectedGuildKnowledge.length,
          guildKnowledgeChars: JSON.stringify(selectedGuildKnowledge).length,
          referencedMessageChars: input.referencedMessage?.length ?? 0,
          currentMessageChars: input.message.length,
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
