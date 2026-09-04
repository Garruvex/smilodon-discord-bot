import type { Logger } from "pino";

import { hashContent } from "../assets/content-hash.js";
import { chatMemoryInstructions, chatMemoryLimits, normalizeForGroundingCheck, validateMemoryActions } from "./chat-memory-policy.js";
import { chatSafetyGuard, type ChatProvider, type ChatRequest, type ChatResponse, type ChatResponseObserver, type ReplyChainMessage } from "./chat-provider.js";
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
import { allowsDurableWrites, resolveChannelMemoryMode, type ChannelMemoryMode } from "../memory/memory-channel-policy.js";
import type { ChatMemoryRecord, GuildKnowledgeRecord } from "./chat-provider.js";
import type { Memory, MemoryEngine, MemoryIngestResult, ProposedMemory } from "../memory/memory.js";

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
  extends Omit<ChatRequest, "recentHistory" | "memories" | "guildKnowledge" | "causalChains" | "replyChainSummary" | "userCustomization" | "birthday" | "enabledTools" | "exampleExchanges" | "personaLore"> {
  guildId: string;
  // The Discord message id that triggered this turn, when there is a single
  // one (mention/ambient chat always have one; other callers may not).
  // Threaded into memoryEngine.ingest's sourceMessageId for "live"-sourced
  // writes, so a stored memory can be traced back to the message that
  // produced it. Omitted/null for turns with no single originating message
  // (e.g. dropped-exchange consolidation, which spans several).
  sourceMessageId?: string | null;
  // Per-guild opt-in (profile.chat.toolCallingEnabled) — whether the
  // registered tools are offered to the model for this turn at all.
  toolsEnabled?: boolean;
  // Per-guild deny-list (profile.chat.disabledTools) — tool names withheld
  // from the model even when toolsEnabled is true.
  disabledToolNames?: ReadonlySet<string>;
  // Older reply-chain hops beyond what ChatTurnSupport.resolveReplyChain
  // kept in `replyChain` — see its `overflow` return value. Condensed into
  // ChatRequest.replyChainSummary here (not by the caller) before the
  // provider is asked to reply, since it needs an LLM call resolved first.
  // Empty when the whole thread already fit, or the current turn isn't a
  // reply at all.
  replyChainOverflow?: readonly ReplyChainMessage[];
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
  // Hash of the complete uploaded personality source (see
  // ResolvedPersona.personalitySourceHash) — used to pin persona-drift
  // evolution instead of hashing `personality` directly, since a compiled
  // bundle's `personality` is only the always-sent core and would miss a
  // lore-only edit. Falls back to hashing `personality` when omitted, for
  // callers that don't go through a compiled bundle at all.
  personalitySourceHash?: string;
}

export class ChatStateCommitError extends Error {
  public constructor(cause: unknown) {
    super("The chat reply was delivered, but its state could not be persisted.", { cause });
    this.name = "ChatStateCommitError";
  }
}

export class ChatConversationService {
  private readonly queue = new KeyedSerialQueue();
  // Every fire-and-forget background write this service starts (dedicated
  // personal-memory extraction, dropped-exchange consolidation) registers
  // itself here for the duration of its own run — see trackBackground and
  // drain. Without this, a process restart right after a reply was
  // delivered could kill one of these mid-write with nothing having
  // waited for it, silently losing whatever it was about to persist.
  private readonly pendingBackgroundWork = new Set<Promise<unknown>>();

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
    personalitySourceHash: string,
    speaker: { id: string; displayName: string },
  ): Promise<void> {
    if (droppedExchanges.length === 0) return;
    const summarizer = this.utilityProvider ?? this.provider;
    const exchangePairs = droppedExchanges.map((exchange) => ({ user: exchange.user.content, assistant: exchange.assistant.content }));
    if (summarizer.summarizeDroppedExchanges) {
      try {
        const facts = await summarizer.summarizeDroppedExchanges(exchangePairs, speaker);
        if (facts.length > 0) {
          const candidates = validateGuildKnowledgeCandidates(
            facts.map((fact) => ({
              subjectType: fact.subjectType,
              subjectId: fact.subjectType === "member" ? speaker.id : guildId,
              topic: "scene_summary",
              slot: fact.slot,
              statement: fact.statement,
              channelScoped: true,
            })),
            { guildId, currentChannelId: channelId, currentUserId: speaker.id, allowedMemberIds: new Set([speaker.id]) },
          );
          if (candidates.length > 0) {
            await this.memoryEngine.ingest({
              guildId, channelId, channelMode, assertedByUserId: speaker.id, sourceMessageId: null,
              source: "consolidation", now: Date.now(),
              proposals: this.toProposals([], candidates, speaker.id),
            });
          }
        }
      } catch (error) {
        this.logger?.warn({ error, guildId, channelId }, "Episodic consolidation failed; dropped exchanges were not summarized");
      }
    }
    // Independent of the summarization block above — a failure or absence
    // of one must never block the other. See ChatProvider.evolvePersonaDrift.
    // Gated to "shared" channels only: drift is one guild-wide overlay
    // (see PersonaDriftStore), so letting an "isolated"/"session_only"
    // channel's exchanges evolve it would leak that channel's content into
    // the persona shown everywhere else — a channel-isolation violation.
    if (personaDriftEnabled && channelMode === "shared" && this.personaDriftStore && summarizer.evolvePersonaDrift) {
      try {
        const evolvePersonaDrift = summarizer.evolvePersonaDrift.bind(summarizer);
        await this.personaDriftStore.evolveFrom(
          guildId,
          personalitySourceHash,
          (currentText) => evolvePersonaDrift(currentText, exchangePairs),
        );
      } catch (error) {
        this.logger?.warn({ error, guildId, channelId }, "Persona drift evolution failed; drift stays at its previous value");
      }
    }
  }

  // Condenses reply-chain hops that fell past the kept-window depth/char
  // cap (see ChatTurnSupport.resolveReplyChain's `overflow`) into one short
  // recap. Runs on the critical path — unlike consolidateDroppedExchanges,
  // this turn's reply needs the result — but only does real work on the
  // rare turn where a reply chain actually goes that deep; an empty
  // overflow or a provider without the capability both resolve to null
  // immediately. Failures are logged and swallowed rather than failing the
  // turn: losing the deep-thread recap is a quality regression, not a
  // reason to not reply at all.
  private async resolveReplyChainSummary(
    overflow: readonly ReplyChainMessage[],
    guildId: string,
    channelId: string,
  ): Promise<string | null> {
    if (overflow.length === 0) return null;
    const summarizer = this.utilityProvider ?? this.provider;
    if (!summarizer.summarizeReplyChainOverflow) return null;
    try {
      const summary = await summarizer.summarizeReplyChainOverflow(
        overflow.map((hop) => ({ authorDisplayName: hop.authorDisplayName, content: hop.content })),
      );
      return summary.trim() || null;
    } catch (error) {
      this.logger?.warn({ error, guildId, channelId }, "Reply-chain overflow summarization failed; continuing without it");
      return null;
    }
  }

  // Dedicated second extraction pass, run after the reply is delivered (see
  // run() below) — see ChatProvider.extractPersonalMemories for why this
  // exists alongside the main reply's own userMemoryActions rather than
  // relying on those alone. Off the user-visible critical path (the reply
  // was already sent), so failures/absence both resolve to an empty array
  // rather than affecting the turn. Scoped to private memory about `speaker`
  // only — the app supplies subjectUserId itself (the extractor's schema has
  // no such field), so a candidate about a mentioned user can never be
  // misattributed. Output still goes through the same validateMemoryActions
  // as the reply's own actions (topic vocabulary, length, secret patterns)
  // before reaching memoryEngine.ingest.
  private async extractPersonalMemories(
    userMessage: string,
    assistantReply: string,
    speaker: { id: string; displayName: string },
    guildId: string,
    channelId: string,
  ): Promise<readonly ProposedMemoryAction[]> {
    // Prefer utilityProvider only if it actually implements this capability
    // — falling back to it regardless (as resolveReplyChainSummary does)
    // would silently lose extraction if a configured utility provider lacks
    // the capability but the main provider has it.
    const extractor = this.utilityProvider?.extractPersonalMemories ? this.utilityProvider : this.provider;
    if (!extractor.extractPersonalMemories) return [];
    try {
      const actions = await extractor.extractPersonalMemories(userMessage, assistantReply, speaker);
      const normalizedMessage = normalizeForGroundingCheck(userMessage);
      const proposedActions = actions
        // Dropped, never force-relabeled: aboutSpeaker is the model's own
        // explicit confirmation this action is about the speaker (see
        // PersonalMemoryExtractionAction) — false means it said otherwise,
        // most likely a third-party fact ("Bob likes pizza") it should
        // never have surfaced from this speaker-only pass at all.
        .filter((action) => action.aboutSpeaker)
        // sourceQuote must be a real, non-trivial excerpt of the actual
        // user message, not something the model traced back to the
        // assistant's reply (or invented outright) — see
        // PersonalMemoryExtractionAction's own doc comment for what this
        // does and doesn't guard against. An empty/blank quote would
        // trivially "match" any message (every string contains ""), so
        // that's rejected too, not just a genuine mismatch.
        .filter((action) => {
          const normalizedQuote = normalizeForGroundingCheck(action.sourceQuote);
          return normalizedQuote.length > 0 && normalizedMessage.includes(normalizedQuote);
        })
        .map((action) => ({ action: action.action, topic: action.topic, slot: action.slot, statement: action.statement, subjectUserId: speaker.id }));
      return validateMemoryActions(proposedActions, new Set([speaker.id]));
    } catch (error) {
      this.logger?.warn({ error, guildId, channelId, userId: speaker.id }, "Personal-memory extraction failed; continuing without it");
      return [];
    }
  }

  // Runs extraction and its own ingest, called fire-and-forget from run()
  // after the main model's own memory write has already landed. A candidate
  // here for the same subject/topic/slot the main model already wrote
  // simply updates that record again (ingest's normal upsert semantics) —
  // deliberately treated as this pass getting the final, more careful say
  // on a fact the main model also touched, rather than needing an explicit
  // merge/precedence step against actions that were never in the same
  // ingest batch. Never throws — logs and swallows its own failures; the
  // caller's .catch is only a backstop against something unexpected escaping.
  private async extractAndIngestPersonalMemories(
    input: ChatConversationInput,
    deliveredAssistantMessage: string,
    channelMode: ChannelMemoryMode,
    now: number,
  ): Promise<void> {
    const extractedActions = await this.extractPersonalMemories(
      input.message, deliveredAssistantMessage, input.currentUser, input.guildId, input.channelId,
    );
    if (extractedActions.length === 0) return;
    const proposals = this.toProposals(extractedActions, [], input.currentUser.id);
    try {
      const result = await this.memoryEngine.ingest({
        guildId: input.guildId, channelId: input.channelId, channelMode,
        assertedByUserId: input.currentUser.id, sourceMessageId: input.sourceMessageId ?? null,
        source: "live", now, proposals,
      });
      this.logMemoryIngestIssues(result, input.guildId, input.channelId, input.currentUser.id);
    } catch (error) {
      this.logger?.warn({ error, guildId: input.guildId, channelId: input.channelId }, "Dedicated personal-memory ingest failed");
    }
  }

  // memoryEngine.ingest() reports rejected (permanently invalid proposals —
  // bad topic/slot, secret content) and failed (transient repository/embedding
  // errors) counts rather than throwing, so a reply can otherwise succeed
  // while its memories silently disappear. Surface that here so it shows up
  // in logs/telemetry instead of vanishing.
  private logMemoryIngestIssues(
    result: MemoryIngestResult,
    guildId: string,
    channelId: string,
    userId: string,
  ): void {
    if (result.rejected === 0 && result.failed === 0) return;
    this.logger?.warn(
      {
        guildId, channelId, userId,
        ingested: result.ingested.length, removed: result.removed,
        rejected: result.rejected, failed: result.failed,
      },
      "Memory ingest had rejected/failed proposals",
    );
  }

  // True while a previous request from this same guild+user is still being
  // processed (or queued behind one that is), so callers can tell the user
  // their new message will be handled after the current one instead of
  // appearing to hang silently. Also true while that previous turn's
  // background personal-memory extraction is still running (see run()'s
  // fire-and-forget this.queue.run call) — the reply itself was already
  // delivered, but the write ordering guarantee that call exists for means
  // a new turn genuinely does wait behind it now.
  public isBusy(guildId: string, userId: string): boolean {
    return this.queue.isBusy(`${guildId}:${userId}`);
  }

  // Registers a fire-and-forget background promise so drain() can wait for
  // it on shutdown. The promise passed in must already have its own error
  // handling (this only tracks settlement, it doesn't swallow or log
  // anything) — it's removed from the set once it settles, success or not.
  private trackBackground(work: Promise<unknown>): void {
    this.pendingBackgroundWork.add(work);
    const stopTracking = (): void => {
      this.pendingBackgroundWork.delete(work);
    };
    work.then(stopTracking, stopTracking);
  }

  // Called from Application.stop() (see bootstrap/application.ts) before
  // the process exits — waits for whatever background writes are still in
  // flight (dedicated extraction, dropped-exchange consolidation) rather
  // than letting a SIGTERM kill them mid-write. Bounded by timeoutMs so a
  // stuck call (a hung provider request, say) can't hang shutdown
  // indefinitely — shutdown proceeds either way once the timeout elapses,
  // logging what was still outstanding rather than losing the signal
  // entirely. Default comfortably exceeds a single extraction provider
  // call's own 30s request timeout (see extractPersonalMemories in each
  // ChatProvider implementation) plus the ingest write after it — a
  // shorter default would routinely kill a slow-but-healthy extraction
  // right as it was about to finish. Doesn't guarantee covering a
  // multi-model fallback chain (each retry gets its own 30s), just the
  // common single-attempt case.
  public async drain(timeoutMs = 40_000): Promise<void> {
    if (this.pendingBackgroundWork.size === 0) return;
    const pendingCount = this.pendingBackgroundWork.size;
    const deadline = Date.now() + timeoutMs;
    // Loops rather than a single Promise.allSettled snapshot: a turn already
    // in flight when shutdown begins can still register a later piece of
    // background work (e.g. consolidateDroppedExchanges, tracked only after
    // the turn's commit/main-ingest complete — see run()) after this method
    // is first called. A one-shot snapshot of the set at call time would
    // resolve once the work it captured settled, without ever waiting on
    // that later addition. Re-snapshotting each pass picks up anything
    // registered while the previous pass was awaiting.
    while (this.pendingBackgroundWork.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        this.logger?.warn(
          { pendingCount, remaining: this.pendingBackgroundWork.size, timeoutMs },
          "Shutdown drain timed out with background memory writes still in flight",
        );
        return;
      }
      const allSettled = Promise.allSettled([...this.pendingBackgroundWork]);
      const timedOut = new Promise<"timed_out">((resolve) => {
        setTimeout(() => resolve("timed_out"), remainingMs).unref?.();
      });
      const result = await Promise.race([allSettled.then(() => "completed" as const), timedOut]);
      if (result === "timed_out") {
        this.logger?.warn(
          { pendingCount, remaining: this.pendingBackgroundWork.size, timeoutMs },
          "Shutdown drain timed out with background memory writes still in flight",
        );
        return;
      }
    }
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
      // Reserved here, at the very top — before any await in this turn,
      // including deliver() — rather than only once deliveredAssistantMessage
      // is known near the end. This turn's own queue.run call (the one
      // wrapping this whole callback) already holds this key's slot, but
      // that slot releases the moment this callback returns; a second
      // queue.run call made *from inside* this callback only takes effect
      // if it runs before some other run() call for the same key captures
      // its `previous` reference. A fast follow-up message can arrive (and
      // call service.run) at any point while this turn is still in
      // progress — mid state-commit, mid main-model memory ingest — and if
      // the extraction reservation hadn't happened yet, that follow-up
      // would capture this turn's own tail and never end up ordered behind
      // the extraction sub-task at all, defeating the whole point. Firing
      // it immediately, synchronously, before the first await, closes that
      // window entirely — every subsequent run() call for this key is
      // guaranteed to see this reservation already in place.
      //
      // The extraction call itself still can't start until
      // deliveredAssistantMessage exists, so the reserved sub-task blocks
      // on resolveExtractionInput below until this turn signals it — an
      // "abort" (null) signal on every exit path (ambient-ignore's early
      // return, any thrown error) via the finally block, or the real
      // message on the success path, so the reservation can never hang
      // forever and leave this key permanently marked busy.
      let resolveExtractionInput!: (value: { assistantMessage: string } | null) => void;
      const extractionInput = new Promise<{ assistantMessage: string } | null>((resolve) => {
        resolveExtractionInput = resolve;
      });
      if (allowsDurableWrites(channelMode)) {
        this.trackBackground(this.queue.run(key, async () => {
          const ready = await extractionInput;
          if (!ready) return;
          await this.extractAndIngestPersonalMemories(input, ready.assistantMessage, channelMode, now);
        }).catch((error: unknown) => {
          this.logger?.warn(
            { error, guildId: input.guildId, channelId: input.channelId },
            "Dedicated personal-memory extraction/ingest failed unexpectedly",
          );
        }));
      }
      try {
      // state loads first (rather than in the same Promise.all as recall)
      // so recall's relevance context can use real recentHistory instead of
      // an empty array — channelId here only scopes the session-exchange
      // transcript; the legacy `.memories` field on this snapshot is unused
      // (private memory reads go through memoryEngine.recall below).
      const state = await this.stateStore.load(input.guildId, input.currentUser.id, input.channelId, now);
      const recentHistory = this.promptHistorySelector.select(state.exchanges);
      const [memoryContext, userCustomization, birthday, replyChainSummary] = await Promise.all([
        this.memoryEngine.recall({
          guildId: input.guildId,
          channelId: input.channelId,
          userId: input.currentUser.id,
          message: input.message,
          recentHistory,
          subjectIds: [input.currentUser.id, ...input.mentionedUsers.map((user) => user.id)],
          now,
          channelMode,
        }),
        this.userCustomizationStore?.load(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
        this.birthdayStore?.getBirthday(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
        this.resolveReplyChainSummary(input.replyChainOverflow ?? [], input.guildId, input.channelId),
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
        replyChain: input.replyChain,
        replyChainSummary,
      });
      // examplePool/loreChunks are the unfiltered candidate lists — only
      // their selector-narrowed results belong in the request, so they're
      // destructured out here purely to keep them off requestInput's spread
      // below.
      const {
        toolsEnabled, disabledToolNames, examplePool, loreChunks, personaDriftEnabled, replyChainOverflow,
        personalitySourceHash, ...requestInput
      } = input;
      void personaDriftEnabled;
      void examplePool;
      void loreChunks;
      void replyChainOverflow;
      void personalitySourceHash;
      const response = await this.provider.reply({
        ...requestInput,
        recentHistory,
        channelMode,
        memories: selectedMemories,
        replyChainSummary,
        guildKnowledge: selectedGuildKnowledge,
        causalChains: memoryContext.causalChains,
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
      // Includes reply-chain authors, not just explicit @mentions — the
      // prompt (see buildChatInstructions' replyChainSection) tells the
      // model to treat the message it's replying to as the subject when the
      // current message is a bare reaction/comment ("i think he likes
      // orange" replying to A's message). Without their id in this set, a
      // correctly-attributed candidate about A would be silently dropped by
      // validateMemoryActions/validateGuildKnowledgeCandidates below, even
      // though the model did exactly what it was told. May also include the
      // bot's own id if a reply chain hop was the bot's prior turn — benign,
      // since no real member record ever collides with it.
      const allowedSubjects = new Set([
        input.currentUser.id,
        ...input.mentionedUsers.map((user) => user.id),
        ...input.replyChain.map((hop) => hop.authorId),
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
            const result = await this.memoryEngine.ingest({
              guildId: input.guildId, channelId: input.channelId, channelMode,
              assertedByUserId: input.currentUser.id, sourceMessageId: input.sourceMessageId ?? null,
              source: "live", now, proposals,
            });
            this.logMemoryIngestIssues(result, input.guildId, input.channelId, input.currentUser.id);
          } catch (error) {
            throw new ChatStateCommitError(error);
          }
        }
        return validatedResponse;
      }
      const deliveredAssistantMessage = await deliver(validatedResponse);
      // Signals the extraction sub-task (reserved at the very top of this
      // callback) that it can proceed — see that reservation's own comment
      // for why the slot is claimed before this point rather than here.
      resolveExtractionInput(allowsDurableWrites(channelMode) ? { assistantMessage: deliveredAssistantMessage } : null);
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
          const result = await this.memoryEngine.ingest({
            guildId: input.guildId, channelId: input.channelId, channelMode,
            assertedByUserId: input.currentUser.id, sourceMessageId: input.sourceMessageId ?? null,
            source: "live", now, proposals,
          });
          this.logMemoryIngestIssues(result, input.guildId, input.channelId, input.currentUser.id);
        } catch (error) {
          throw new ChatStateCommitError(error);
        }
      }
      // Not awaited: this.queue is keyed per guildId+userId (see isBusy),
      // and consolidateDroppedExchanges is genuinely off the user-visible
      // critical path (per its own doc comment) — an LLM summarization call
      // that has nothing left to report back to this turn's caller. Awaiting
      // it here would hold that same key's lock until it finishes, so the
      // user's very next message queues behind invisible post-processing of
      // a reply they already received. It already catches and logs its own
      // failures internally and never throws; the .catch below is only a
      // backstop against something unexpected escaping that.
      this.trackBackground(this.consolidateDroppedExchanges(
        input.guildId, input.channelId, channelMode, droppedExchanges, input.personaDriftEnabled ?? false,
        input.personalitySourceHash ?? hashContent(input.personality),
        { id: input.currentUser.id, displayName: input.currentUser.displayName },
      ).catch((error: unknown) => {
        this.logger?.warn({ error, guildId: input.guildId, channelId: input.channelId }, "Dropped-exchange consolidation failed unexpectedly");
      }));
      return validatedResponse;
      } finally {
        // No-op if the success path above already resolved this (a
        // Promise's second resolve call is ignored) — this is purely the
        // safety net for every path that returns or throws before ever
        // reaching that point (ambientAction "ignore"'s early return,
        // ChatStateCommitError, a reply provider failure), so the reserved
        // extraction sub-task is never left waiting on a promise that
        // would otherwise never settle.
        resolveExtractionInput(null);
      }
    });
  }
}
