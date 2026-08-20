import type { Logger } from "pino";

import { chatMemoryInstructions, chatMemoryLimits, validateMemoryActions } from "./chat-memory-policy.js";
import { chatSafetyGuard, type ChatProvider, type ChatRequest, type ChatResponse, type ChatResponseObserver } from "./chat-provider.js";
import type { ChatSessionExchange, ChatStateStore, EmbeddedMemoryAction } from "./chat-state-store.js";
import type { UserCustomizationStore } from "./user-customization-store.js";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import { guildKnowledgeInstructions, validateGuildKnowledgeCandidates, type ValidatedGuildKnowledgeCandidate } from "./guild-knowledge-policy.js";
import type { EmbeddedGuildKnowledgeCandidate, GuildKnowledgeStore } from "./guild-knowledge-store.js";
import type { ProposedMemoryAction } from "./chat-provider.js";
import type { EmbeddingsClient } from "../../infrastructure/chat/openai-embeddings-client.js";
import { RelevantGuildMemorySelector, type GuildMemorySelector } from "./guild-memory-selector.js";
import { RecentPromptHistorySelector, type PromptHistorySelector } from "./prompt-history-selector.js";
import { RelevantUserMemorySelector, type UserMemorySelector } from "./user-memory-selector.js";
import { RelevantExampleExchangeSelector, type ExampleExchangeSelector } from "./example-exchange-selector.js";
import type { ExampleExchange } from "./example-exchange.js";
import type { BirthdayStore } from "../birthdays/birthday-store.js";
import type { ChatToolRegistry } from "./tools/chat-tool-registry.js";

export interface ChatConversationInput
  extends Omit<ChatRequest, "recentHistory" | "memories" | "guildKnowledge" | "userCustomization" | "birthday" | "enabledTools" | "exampleExchanges"> {
  guildId: string;
  // Per-guild opt-in (profile.chat.toolCallingEnabled) — whether the
  // registered tools are offered to the model for this turn at all.
  toolsEnabled?: boolean;
  // Full unfiltered pool of the guild's uploaded example exchanges (see
  // ChatTurnSupport.loadExampleExchanges) — narrowed to the relevant subset
  // by exampleExchangeSelector inside run(), same as guildKnowledge/memories.
  examplePool: readonly ExampleExchange[];
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
    private readonly exampleExchangeSelector: ExampleExchangeSelector = new RelevantExampleExchangeSelector(),
    private readonly userCustomizationStore: UserCustomizationStore | null = null,
    private readonly userMemorySelector: UserMemorySelector = new RelevantUserMemorySelector(),
    private readonly birthdayStore: BirthdayStore | null = null,
    private readonly toolRegistry: ChatToolRegistry | null = null,
    private readonly embeddingsClient: EmbeddingsClient | null = null,
    private readonly logger: Logger | null = null,
    // Provider used for the two standalone structured-output calls
    // (analyzeUserCustomization is called elsewhere — this is
    // summarizeDroppedExchanges) — defaults to the same instance as
    // `provider` when a dedicated utility provider isn't configured, so
    // this stays optional/backward compatible.
    private readonly utilityProvider: ChatProvider | null = null,
  ) {}

  // Computes each candidate's embedding (in parallel) before it's persisted
  // — a network call, so it belongs here rather than inside the store
  // (stores stay dumb, see GuildKnowledgeStore). A failed embed degrades to
  // null rather than failing the whole turn; the selector treats a null
  // embedding as a 0 similarity contribution.
  private async embedCandidates(
    candidates: readonly ValidatedGuildKnowledgeCandidate[],
  ): Promise<EmbeddedGuildKnowledgeCandidate[]> {
    if (!this.embeddingsClient) return candidates.map((candidate) => ({ ...candidate, embedding: null }));
    return Promise.all(candidates.map(async (candidate) => ({
      ...candidate,
      embedding: await this.embeddingsClient!.embed(candidate.statement).catch(() => null),
    })));
  }

  // Same shape as embedCandidates, but for private user-memory actions. A
  // "remove" action has no statement to embed (statement is null after
  // validateMemoryActions), so it's passed through with a null embedding.
  private async embedActions(
    actions: readonly ProposedMemoryAction[],
  ): Promise<EmbeddedMemoryAction[]> {
    if (!this.embeddingsClient) return actions.map((action) => ({ ...action, embedding: null }));
    return Promise.all(actions.map(async (action) => ({
      ...action,
      embedding: action.statement
        ? await this.embeddingsClient!.embed(action.statement).catch(() => null)
        : null,
    })));
  }

  // Summarizes exchanges about to age out of a channel's recent-history
  // window into durable, channel-scoped guild knowledge instead of losing
  // them silently — see ChatProvider.summarizeDroppedExchanges. Off the
  // user-visible critical path (always called after deliver() has already
  // sent the reply); failures are logged and swallowed, never surfaced as a
  // ChatStateCommitError, since the turn itself already committed
  // successfully by the time this runs.
  private async consolidateDroppedExchanges(
    guildId: string,
    channelId: string,
    droppedExchanges: readonly ChatSessionExchange[],
  ): Promise<void> {
    const summarizer = this.utilityProvider ?? this.provider;
    if (droppedExchanges.length === 0 || !summarizer.summarizeDroppedExchanges) return;
    try {
      const facts = await summarizer.summarizeDroppedExchanges(
        droppedExchanges.map((exchange) => ({ user: exchange.user.content, assistant: exchange.assistant.content })),
      );
      if (facts.length === 0) return;
      const candidates = validateGuildKnowledgeCandidates(
        facts.map((fact) => ({
          subjectType: "guild" as const,
          subjectId: guildId,
          topic: "scene_summary",
          slot: fact.slot,
          statement: fact.statement,
          channelScoped: true,
        })),
        { guildId, currentChannelId: channelId, currentUserId: "", allowedMemberIds: new Set() },
      );
      if (candidates.length === 0) return;
      await this.guildKnowledgeStore.propose({
        guildId,
        assertedByUserId: null,
        candidates: await this.embedCandidates(candidates),
        now: Date.now(),
      });
    } catch (error) {
      this.logger?.warn({ error, guildId, channelId }, "Episodic consolidation failed; dropped exchanges were not summarized");
    }
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
        this.stateStore.load(input.guildId, input.currentUser.id, input.channelId, now),
        this.guildKnowledgeStore.loadConfirmed(input.guildId, input.channelId),
        this.userCustomizationStore?.load(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
        this.birthdayStore?.getBirthday(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
      ]);
      const recentHistory = this.promptHistorySelector.select(state.exchanges);
      const [selectedGuildKnowledge, selectedMemories, selectedExampleExchanges] = await Promise.all([
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
        this.exampleExchangeSelector.select({
          records: input.examplePool,
          currentUser: input.currentUser,
          mentionedUsers: input.mentionedUsers,
          recentHistory,
          message: input.message,
          now,
        }),
      ]);
      // examplePool is the unfiltered candidate list — only its
      // selector-narrowed result (selectedExampleExchanges) belongs in the
      // request, so it's destructured out here purely to keep it off
      // requestInput's spread below.
      const { toolsEnabled, examplePool, ...requestInput } = input;
      void examplePool;
      const response = await this.provider.reply({
        ...requestInput,
        recentHistory,
        memories: selectedMemories,
        guildKnowledge: selectedGuildKnowledge,
        exampleExchanges: selectedExampleExchanges,
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
          exampleExchangeRecords: selectedExampleExchanges.length,
          exampleExchangeChars: JSON.stringify(selectedExampleExchanges).length,
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
            currentChannelId: input.channelId,
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
              channelId: input.channelId,
              actions: await this.embedActions(validatedResponse.userMemoryActions),
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
      let droppedExchanges: readonly ChatSessionExchange[] = [];
      try {
        const result = await this.stateStore.commitSuccessfulExchange({
          guildId: input.guildId,
          userId: input.currentUser.id,
          channelId: input.channelId,
          userMessage: input.message.slice(0, chatMemoryLimits.maxUserMessageChars),
          assistantMessage: deliveredAssistantMessage.slice(0, chatMemoryLimits.maxAssistantMessageChars),
          actions: await this.embedActions(validatedResponse.userMemoryActions),
          now,
        });
        droppedExchanges = result.droppedExchanges;
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
      await this.consolidateDroppedExchanges(input.guildId, input.channelId, droppedExchanges);
      return validatedResponse;
    });
  }
}
