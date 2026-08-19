import { chatMemoryInstructions, chatMemoryLimits, validateMemoryActions } from "./chat-memory-policy.js";
import { chatSafetyGuard, type ChatProvider, type ChatRequest, type ChatResponse, type ChatResponseObserver } from "./chat-provider.js";
import type { ChatStateStore } from "./chat-state-store.js";
import type { UserCustomizationStore } from "./user-customization-store.js";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import { guildKnowledgeInstructions, validateGuildKnowledgeCandidates } from "./guild-knowledge-policy.js";
import type { EmbeddedGuildKnowledgeCandidate, GuildKnowledgeStore } from "./guild-knowledge-store.js";
import type { ProposedGuildKnowledgeCandidate } from "./chat-provider.js";
import type { EmbeddingsClient } from "../../infrastructure/chat/openai-embeddings-client.js";
import { RelevantGuildMemorySelector, type GuildMemorySelector } from "./guild-memory-selector.js";
import { RecentPromptHistorySelector, type PromptHistorySelector } from "./prompt-history-selector.js";
import { RelevantUserMemorySelector, type UserMemorySelector } from "./user-memory-selector.js";
import type { BirthdayStore } from "../birthdays/birthday-store.js";
import type { ChatToolRegistry } from "./tools/chat-tool-registry.js";

export interface ChatConversationInput
  extends Omit<ChatRequest, "recentHistory" | "memories" | "guildKnowledge" | "userCustomization" | "birthday" | "enabledTools"> {
  guildId: string;
  // Per-guild opt-in (profile.chat.toolCallingEnabled) — whether the
  // registered tools are offered to the model for this turn at all.
  toolsEnabled?: boolean;
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
    private readonly guildMemorySelector: GuildMemorySelector = new RelevantGuildMemorySelector(),
    private readonly promptHistorySelector: PromptHistorySelector = new RecentPromptHistorySelector(),
    private readonly userCustomizationStore: UserCustomizationStore | null = null,
    private readonly userMemorySelector: UserMemorySelector = new RelevantUserMemorySelector(),
    private readonly birthdayStore: BirthdayStore | null = null,
    private readonly toolRegistry: ChatToolRegistry | null = null,
    private readonly embeddingsClient: EmbeddingsClient | null = null,
  ) {}

  // Computes each candidate's embedding (in parallel) before it's persisted
  // — a network call, so it belongs here rather than inside the store
  // (stores stay dumb, see GuildKnowledgeStore). A failed embed degrades to
  // null rather than failing the whole turn; the selector treats a null
  // embedding as a 0 similarity contribution.
  private async embedCandidates(
    candidates: readonly ProposedGuildKnowledgeCandidate[],
  ): Promise<EmbeddedGuildKnowledgeCandidate[]> {
    if (!this.embeddingsClient) return candidates.map((candidate) => ({ ...candidate, embedding: null }));
    return Promise.all(candidates.map(async (candidate) => ({
      ...candidate,
      embedding: await this.embeddingsClient!.embed(candidate.statement).catch(() => null),
    })));
  }

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
      const [state, guildKnowledge, userCustomization, birthday] = await Promise.all([
        this.stateStore.load(input.guildId, input.currentUser.id, now),
        this.guildKnowledgeStore.loadConfirmed(input.guildId),
        this.userCustomizationStore?.load(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
        this.birthdayStore?.getBirthday(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
      ]);
      const recentHistory = this.promptHistorySelector.select(state.exchanges);
      const [selectedGuildKnowledge, selectedMemories] = await Promise.all([
        this.guildMemorySelector.select({
          records: guildKnowledge,
          currentUser: input.currentUser,
          mentionedUsers: input.mentionedUsers,
          recentHistory,
          message: input.message,
          now,
        }),
        this.userMemorySelector.select({
          records: state.memories,
          currentUser: input.currentUser,
          mentionedUsers: input.mentionedUsers,
          recentHistory,
          message: input.message,
          now,
        }),
      ]);
      const { toolsEnabled, ...requestInput } = input;
      const response = await this.provider.reply({
        ...requestInput,
        recentHistory,
        memories: selectedMemories,
        guildKnowledge: selectedGuildKnowledge,
        userCustomization,
        birthday: birthday ? { month: birthday.month, day: birthday.day } : null,
        enabledTools: toolsEnabled && this.toolRegistry ? this.toolRegistry.list() : [],
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
          memoryRecords: selectedMemories.length,
          memoryChars: JSON.stringify(selectedMemories).length,
          guildKnowledgeRecords: selectedGuildKnowledge.length,
          guildKnowledgeChars: JSON.stringify(selectedGuildKnowledge).length,
          replyChainMessages: input.replyChain.length,
          replyChainChars: JSON.stringify(input.replyChain).length,
          channelHistoryMessages: input.channelHistory.length,
          channelHistoryChars: JSON.stringify(input.channelHistory).length,
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
      // ambientAction "ignore" and reactionEmoji are independent signals:
      // an ambient turn can reply, react, both, or neither. No reply here
      // (ambientAction !== "reply") means `deliver` is never called; if a
      // reaction is still set, the model engaged (if only with an emoji)
      // and may have picked up something memory-worthy, so persist via
      // applyMemoryActions (no session exchange — there's no assistant
      // reply text to record). Fully ignored (no reply, no reaction) means
      // no reply, no memory write, no guild-knowledge write. The caller
      // (AmbientChatBehavior) inspects ambientAction/reactionEmoji on the
      // returned response to react or no-op.
      if (input.triggerMode === "ambient" && validatedResponse.ambientAction !== "reply") {
        if (validatedResponse.reactionEmoji) {
          try {
            await this.stateStore.applyMemoryActions({
              guildId: input.guildId,
              userId: input.currentUser.id,
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
              candidates: await this.embedCandidates(validatedResponse.guildKnowledgeCandidates),
              now,
            });
          } catch (error) {
            throw new ChatStateCommitError(error);
          }
        }
        return validatedResponse;
      }
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
          candidates: await this.embedCandidates(validatedResponse.guildKnowledgeCandidates),
          now,
        });
      } catch (error) {
        throw new ChatStateCommitError(error);
      }
      return validatedResponse;
    });
  }
}
