import type { Logger } from "pino";

import { hashContent } from "../assets/content-hash.js";
import { chatMemoryInstructions, chatMemoryLimits, validateMemoryActions } from "./chat-memory-policy.js";
import { chatSafetyGuard, type ChatProvider, type ChatRequest, type ChatResponse, type ChatResponseObserver } from "./chat-provider.js";
import type { ChatSessionExchange, ChatStateStore } from "./chat-state-store.js";
import type { UserCustomizationStore } from "./user-customization-store.js";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import { guildKnowledgeInstructions, validateGuildKnowledgeCandidates, type ValidatedGuildKnowledgeCandidate } from "./guild-knowledge-policy.js";
import type { ProposedMemoryAction } from "./chat-provider.js";
import { RecentPromptHistorySelector, type PromptHistorySelector } from "./prompt-history-selector.js";
import { RelevantExampleExchangeSelector, type ExampleExchangeSelector } from "./example-exchange-selector.js";
import { RelevantPersonaLoreSelector, type PersonaLoreSelector } from "./persona-lore-selector.js";
import type { PersonaDriftStore } from "./persona-drift-store.js";
import type { ExampleExchange } from "./example-exchange.js";
import type { PersonaLoreChunk } from "./persona-source.js";
import type { BirthdayStore } from "../birthdays/birthday-store.js";
import type { ChatToolRegistry } from "./tools/chat-tool-registry.js";
import { resolveChannelMemoryMode, type ChannelMemoryMode } from "../memory/memory-channel-policy.js";
import type { ChatMemoryRecord, GuildKnowledgeRecord } from "./chat-provider.js";
import type { Memory, MemoryEngine, ProposedMemory } from "../memory/memory.js";

// Adapts a unified Memory back into the legacy prompt-facing record shapes
// (ChatRequest still expects `memories`/`guildKnowledge` in their original
// shape — changing that touches every chat provider's prompt builder, out of
// scope for this pass). `audience: "private"` maps to ChatMemoryRecord (the
// owner IS the asserter for private memory, by construction); anything else
// maps to GuildKnowledgeRecord.
function toChatMemoryRecord(memory: Memory): ChatMemoryRecord {
  return {
    id: memory.id,
    assertedByUserId: memory.ownerUserId!,
    subjectUserId: memory.subjectId,
    topic: memory.topic,
    slot: memory.slot,
    statement: memory.statement,
    updatedAt: memory.updatedAt,
    embedding: memory.embedding ? [...memory.embedding] : null,
  };
}

const memorySourceToGuildKnowledgeSource: Record<Memory["source"], GuildKnowledgeRecord["source"]> = {
  live: "community",
  explicit: "self_report",
  administrator: "administrator",
  consolidation: "consolidation",
};

function toGuildKnowledgeRecord(memory: Memory): GuildKnowledgeRecord {
  return {
    id: memory.id,
    subjectType: memory.subjectType,
    subjectId: memory.subjectId,
    topic: memory.topic,
    slot: memory.slot,
    statement: memory.statement,
    source: memorySourceToGuildKnowledgeSource[memory.source],
    updatedAt: memory.updatedAt,
    embedding: memory.embedding ? [...memory.embedding] : null,
  };
}

function memoryKindForTopic(topic: string): "fact" | "preference" | "episode" {
  if (topic === "scene_summary") return "episode";
  if (topic === "preference") return "preference";
  return "fact";
}

export interface ChatConversationInput
  extends Omit<ChatRequest, "recentHistory" | "memories" | "guildKnowledge" | "userCustomization" | "birthday" | "enabledTools" | "exampleExchanges" | "personaLore"> {
  guildId: string;
  // Per-guild opt-in (profile.chat.toolCallingEnabled) — whether the
  // registered tools are offered to the model for this turn at all.
  toolsEnabled?: boolean;
  // Per-guild deny-list (profile.chat.disabledTools) — tool names withheld
  // from the model even when toolsEnabled is true.
  disabledToolNames?: ReadonlySet<string>;
  // Full unfiltered pool of the resolved guild persona's example exchanges — narrowed to the relevant subset
  // by exampleExchangeSelector inside run(), same as guildKnowledge/memories.
  examplePool: readonly ExampleExchange[];
  // Full candidate pool of the resolved guild persona's lore chunks — empty
  // for guilds without a compiled personality bundle. Narrowed to the
  // relevant subset by personaLoreSelector inside run(), same pattern as
  // examplePool above.
  loreChunks: readonly PersonaLoreChunk[];
  // Per-channel memory isolation mode, keyed by channel id — resolved from
  // guild configuration by the caller (not looked up here, keeping this
  // service decoupled from the config schema). Omitted/missing channel
  // entries default to "shared" (today's behavior) — see
  // resolveChannelMemoryMode. Wiring an actual admin-configurable source for
  // this map is a follow-up (a `channelMemoryModes` guild-config field plus
  // a setup setting) — until then every channel behaves exactly as before.
  channelMemoryModes?: Readonly<Record<string, ChannelMemoryMode>>;
  // Per-guild opt-in (profile.chat.personaDriftEnabled) — whether the
  // consolidation hook below also nudges the guild's persona-drift overlay
  // after this turn. `personaDrift` (inherited from ChatRequest) is the
  // text to inject this turn and is resolved upstream by PersonaSource,
  // already gated on this same flag — this field only controls the write
  // side.
  personaDriftEnabled?: boolean;
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
    private readonly memoryEngine: MemoryEngine,
    private readonly promptHistorySelector: PromptHistorySelector = new RecentPromptHistorySelector(),
    private readonly exampleExchangeSelector: ExampleExchangeSelector = new RelevantExampleExchangeSelector(),
    private readonly personaLoreSelector: PersonaLoreSelector = new RelevantPersonaLoreSelector(),
    private readonly userCustomizationStore: UserCustomizationStore | null = null,
    private readonly birthdayStore: BirthdayStore | null = null,
    private readonly toolRegistry: ChatToolRegistry | null = null,
    private readonly logger: Logger | null = null,
    // Provider used for the two standalone structured-output calls
    // (analyzeUserCustomization is called elsewhere — this is
    // summarizeDroppedExchanges) — defaults to the same instance as
    // `provider` when a dedicated utility provider isn't configured, so
    // this stays optional/backward compatible.
    private readonly utilityProvider: ChatProvider | null = null,
    private readonly personaDriftStore: PersonaDriftStore | null = null,
  ) {}

  // Converts a turn's validated private-memory actions + guild-knowledge
  // candidates into the unified proposal shape MemoryEngine.ingest expects.
  // Note: validateMemoryActions/validateGuildKnowledgeCandidates already ran
  // (topic vocabulary, subject authorization, secret/length checks) —
  // this only reshapes their output. Crucially, guild candidates' *raw*
  // `channelScoped` flag is passed through, not their already-resolved
  // `channelId` — the engine's channel-mode policy (memory-channel-policy.ts)
  // is the actual authority on final scope, especially for "isolated"
  // channels, where the model's flag must never be trusted directly.
  private toProposals(
    userMemoryActions: readonly ProposedMemoryAction[],
    guildKnowledgeCandidates: readonly ValidatedGuildKnowledgeCandidate[],
    currentUserId: string,
  ): ProposedMemory[] {
    const proposals: ProposedMemory[] = [];
    for (const action of userMemoryActions) {
      if (action.action === "upsert") {
        proposals.push({
          action: "upsert", audience: "private", kind: memoryKindForTopic(action.topic),
          ownerUserId: currentUserId, subjectType: "member", subjectId: action.subjectUserId,
          topic: action.topic, slot: action.slot, statement: action.statement!, channelScoped: false,
        });
      } else {
        proposals.push({
          action: "remove", ownerUserId: currentUserId, subjectType: "member",
          subjectId: action.subjectUserId, topic: action.topic, slot: action.slot,
        });
      }
    }
    for (const candidate of guildKnowledgeCandidates) {
      proposals.push({
        action: "upsert", audience: "guild", kind: memoryKindForTopic(candidate.topic),
        ownerUserId: null, subjectType: candidate.subjectType, subjectId: candidate.subjectId,
        topic: candidate.topic, slot: candidate.slot, statement: candidate.statement,
        channelScoped: candidate.channelScoped,
      });
    }
    return proposals;
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
    channelMode: ChannelMemoryMode,
    droppedExchanges: readonly ChatSessionExchange[],
    personaDriftEnabled: boolean,
    personality: string,
  ): Promise<void> {
    if (droppedExchanges.length === 0) return;
    const summarizer = this.utilityProvider ?? this.provider;
    const exchangePairs = droppedExchanges.map((exchange) => ({ user: exchange.user.content, assistant: exchange.assistant.content }));
    if (summarizer.summarizeDroppedExchanges) {
      try {
        const facts = await summarizer.summarizeDroppedExchanges(exchangePairs);
        if (facts.length > 0) {
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
          if (candidates.length > 0) {
            await this.memoryEngine.ingest({
              guildId, channelId, channelMode, assertedByUserId: null, sourceMessageId: null,
              source: "consolidation", now: Date.now(),
              proposals: this.toProposals([], candidates, ""),
            });
          }
        }
      } catch (error) {
        this.logger?.warn({ error, guildId, channelId }, "Episodic consolidation failed; dropped exchanges were not summarized");
      }
    }
    // Independent of the summarization block above — a failure or absence
    // of one must never block the other. See ChatProvider.evolvePersonaDrift.
    if (personaDriftEnabled && this.personaDriftStore && summarizer.evolvePersonaDrift) {
      try {
        const evolvePersonaDrift = summarizer.evolvePersonaDrift.bind(summarizer);
        await this.personaDriftStore.evolveFrom(
          guildId,
          hashContent(personality),
          (currentText) => evolvePersonaDrift(currentText, exchangePairs),
        );
      } catch (error) {
        this.logger?.warn({ error, guildId, channelId }, "Persona drift evolution failed; drift stays at its previous value");
      }
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
    const channelMode = resolveChannelMemoryMode(input.channelMemoryModes ?? {}, input.channelId);
    return this.queue.run(key, async () => {
      const now = Date.now();
      // state loads first (rather than in the same Promise.all as recall)
      // so recall's relevance context can use real recentHistory instead of
      // an empty array — channelId here only scopes the session-exchange
      // transcript; the legacy `.memories` field on this snapshot is unused
      // (private memory reads go through memoryEngine.recall below).
      const state = await this.stateStore.load(input.guildId, input.currentUser.id, input.channelId, now);
      const recentHistory = this.promptHistorySelector.select(state.exchanges);
      const [memoryContext, userCustomization, birthday] = await Promise.all([
        this.memoryEngine.recall({
          guildId: input.guildId,
          channelId: input.channelId,
          userId: input.currentUser.id,
          message: input.message,
          recentHistory,
          subjectIds: [input.currentUser.id, ...input.mentionedUsers.map((user) => user.id)],
          now,
        }),
        this.userCustomizationStore?.load(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
        this.birthdayStore?.getBirthday(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
      ]);
      const selectedMemories = memoryContext.memories.filter((memory) => memory.audience === "private").map(toChatMemoryRecord);
      const selectedGuildKnowledge = memoryContext.memories.filter((memory) => memory.audience !== "private").map(toGuildKnowledgeRecord);
      const selectedExampleExchanges = await this.exampleExchangeSelector.select({
        records: input.examplePool,
        currentUser: input.currentUser,
        mentionedUsers: input.mentionedUsers,
        recentHistory,
        message: input.message,
        now,
      });
      const selectedPersonaLore = await this.personaLoreSelector.select({
        chunks: input.loreChunks,
        recentHistory,
        message: input.message,
        now,
      });
      // examplePool/loreChunks are the unfiltered candidate lists — only
      // their selector-narrowed results belong in the request, so they're
      // destructured out here purely to keep them off requestInput's spread
      // below.
      const { toolsEnabled, disabledToolNames, examplePool, loreChunks, personaDriftEnabled, ...requestInput } = input;
      void personaDriftEnabled;
      void examplePool;
      void loreChunks;
      const response = await this.provider.reply({
        ...requestInput,
        recentHistory,
        memories: selectedMemories,
        guildKnowledge: selectedGuildKnowledge,
        exampleExchanges: selectedExampleExchanges.map((exchange) => (
          { tags: exchange.tags, user: exchange.user, character: exchange.character }
        )),
        personaLore: selectedPersonaLore.map((chunk) => ({ heading: chunk.heading, text: chunk.text })),
        userCustomization,
        birthday: birthday ? { month: birthday.month, day: birthday.day } : null,
        enabledTools: toolsEnabled && this.toolRegistry
          ? this.toolRegistry.list().filter((tool) => !disabledToolNames?.has(tool.name))
          : [],
      }, observer);
      const allowedSubjects = new Set([
        input.currentUser.id,
        ...input.mentionedUsers.map((user) => user.id),
      ]);
      const validatedResponse = {
        ...response,
        contextUsage: {
          personalityChars: input.personality.length,
          personaLoreChars: JSON.stringify(selectedPersonaLore).length,
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
      const proposals = this.toProposals(
        validatedResponse.userMemoryActions, validatedResponse.guildKnowledgeCandidates, input.currentUser.id,
      );
      // ambientAction "ignore" and reactionEmoji are independent signals:
      // an ambient turn can reply, react, both, or neither. No reply here
      // (ambientAction !== "reply") means `deliver` is never called; if a
      // reaction is still set, the model engaged (if only with an emoji)
      // and may have picked up something memory-worthy, so persist via
      // memoryEngine.ingest (no session exchange — there's no assistant
      // reply text to record). Fully ignored (no reply, no reaction) means
      // no reply, no memory write, no guild-knowledge write. The caller
      // (AmbientChatBehavior) inspects ambientAction/reactionEmoji on the
      // returned response to react or no-op.
      if (input.triggerMode === "ambient" && validatedResponse.ambientAction !== "reply") {
        if (validatedResponse.reactionEmoji && proposals.length > 0) {
          try {
            await this.memoryEngine.ingest({
              guildId: input.guildId, channelId: input.channelId, channelMode,
              assertedByUserId: input.currentUser.id, sourceMessageId: null,
              source: "live", now, proposals,
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
        // actions always empty here — private-memory writes now go through
        // memoryEngine.ingest below; this call is left in place purely for
        // its session-exchange bookkeeping (chat_sessions) and
        // droppedExchanges eviction reporting, both untouched by this
        // migration (see chat-state-store.ts).
        const result = await this.stateStore.commitSuccessfulExchange({
          guildId: input.guildId,
          userId: input.currentUser.id,
          channelId: input.channelId,
          userMessage: input.message.slice(0, chatMemoryLimits.maxUserMessageChars),
          assistantMessage: deliveredAssistantMessage.slice(0, chatMemoryLimits.maxAssistantMessageChars),
          actions: [],
          now,
        });
        droppedExchanges = result.droppedExchanges;
      } catch (error) {
        throw new ChatStateCommitError(error);
      }
      if (proposals.length > 0) {
        try {
          await this.memoryEngine.ingest({
            guildId: input.guildId, channelId: input.channelId, channelMode,
            assertedByUserId: input.currentUser.id, sourceMessageId: null,
            source: "live", now, proposals,
          });
        } catch (error) {
          throw new ChatStateCommitError(error);
        }
      }
      await this.consolidateDroppedExchanges(
        input.guildId, input.channelId, channelMode, droppedExchanges, input.personaDriftEnabled ?? false, input.personality,
      );
      return validatedResponse;
    });
  }
}
