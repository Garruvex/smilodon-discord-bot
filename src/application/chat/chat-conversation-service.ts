import { runGuardedChatTurn } from "./guarded-chat-turn.js";
import { effectiveChatCapabilities } from "./chat-capabilities.js";
import { authorizeConversationEffects } from "./conversation-effects.js";
import type { ActiveConversationTurnPlan, ConversationTurnPlan } from "./conversation-turn-plan.js";
import { assertTurnActive, withTurnAbort } from "./turn-work-budget.js";
import type { GuardedContextPort } from "./guarded-conversation-context.js";
import { captureIncompleteTurnProvenance } from "./context-provenance.js";
import { isRecipientCorrection } from "./character-decision.js";
import type { Logger } from "pino";
import { performance } from "node:perf_hooks";
import { currentDiagnosticTraceSequence, diagnosticElapsed, diagnosticStore, emitChatDiagnostic, safeFailure, withDiagnosticScope } from "../diagnostics/chat-diagnostics.js";
import type { CharacterRuntime, CharacterPreparedTurn } from "./character-runtime.js";

import { hashContent } from "../assets/content-hash.js";
import { stripUntrustedMarkers } from "./attribution-verification.js";
import { chatMemoryInstructions, chatMemoryLimits, importanceRatingToLevel, normalizeForGroundingCheck, validateMemoryActions } from "./chat-memory-policy.js";
import { ChatProviderError, chatSafetyGuard, type ChannelHistoryMessage, type ChatProvider, type ChatRequest, type ChatResponse, type ChatResponseObserver, type ReplyChainMessage } from "./chat-provider.js";
import type { ChatSessionExchange, ChatStateStore } from "./chat-state-store.js";
import type { UserCustomizationStore } from "./user-customization-store.js";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import { ChatScheduler, balancedChatLimits, type ChatActivityLimits, type OpportunityCancellationReason } from "./chat-scheduler.js";
import { ConversationEpisodes } from "./conversation-episodes.js";
import { ConversationDecisionEngine, reportConversationDecision } from "./conversation-decision-engine.js";
import { resolveConversationTrigger } from "./conversation-trigger.js";
import { observedSubjectNames } from "../memory/observed-subject-names.js";
import type { ConversationEpisodeStore } from "./conversation-episode-store.js";
import { participationDecision } from "./participation-decision.js";
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
import type { ChatTool } from "./tools/chat-tool.js";
import { allowsDurableWrites, resolveChannelMemoryMode, type ChannelMemoryMode } from "../memory/memory-channel-policy.js";
import type { ChatMemoryRecord, GuildKnowledgeRecord } from "./chat-provider.js";
import type { Memory, MemoryEngine, MemoryIngestResult, ProposedMemory } from "../memory/memory.js";
import type { PersonalMemoryExtractionQueueStore } from "../context/personal-memory-extraction-queue.js";

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

// Size of what the model actually receives for these records — buildChatContext
// (chat-structured-output.ts) only ever reads subject/topic/slot/statement off
// ChatMemoryRecord/GuildKnowledgeRecord, never `.embedding`. Used for the
// contextUsage char-count metrics below; JSON.stringify'ing the records
// as-is would count each record's embedding vector (thousands of characters
// of floats) against a metric meant to reflect prompt-injection budget,
// wildly overstating it relative to what was actually sent.
function promptSizeOf(records: readonly { embedding: unknown }[]): number {
  return JSON.stringify(records.map(({ embedding: _embedding, ...rest }) => rest)).length;
}

// Same grounding role as PersonalMemoryExtractionAction.sourceQuote/the
// dedicated extractor's own check (see extractPersonalMemories below), but
// applied to the main reply's own memory/guild-knowledge proposals — these
// are produced in the same structured-output call as the reply text, so a
// misattributed conclusion the model draws (see attribution-verification.ts)
// can otherwise become a durable write even after the reply text itself
// gets corrected, since that correction never touches these fields. Checks
// that `quote` genuinely appears in something `speakerId` said this turn —
// <current_message> when speakerId is the current user, or a <reply_chain>/
// <channel_history> line actually authored by speakerId otherwise. An empty
// or missing quote is never grounded (the model must supply one, not omit
// it to dodge the check).
function isGroundedForSpeaker(
  quote: string | null,
  speakerId: string,
  message: string,
  currentUserId: string,
  replyChain: readonly ReplyChainMessage[],
  channelHistory: readonly ChannelHistoryMessage[],
): boolean {
  const normalizedQuote = normalizeForGroundingCheck(quote ?? "");
  if (!normalizedQuote) return false;
  if (speakerId === currentUserId && normalizeForGroundingCheck(message).includes(normalizedQuote)) return true;
  for (const hop of [...replyChain, ...channelHistory]) {
    if (hop.authorId === speakerId && normalizeForGroundingCheck(hop.content).includes(normalizedQuote)) return true;
  }
  return false;
}

// Weaker variant for a guild-knowledge candidate about a non-member subject
// (guild/team/project/npc/faction/location) — there's no single "author" to
// check the quote against, so this only guards against outright fabrication:
// the quote must appear somewhere in this turn's actual context, not
// necessarily from a specific person.
function isGroundedAnywhere(
  quote: string,
  message: string,
  replyChain: readonly ReplyChainMessage[],
  channelHistory: readonly ChannelHistoryMessage[],
): boolean {
  const normalizedQuote = normalizeForGroundingCheck(quote);
  if (!normalizedQuote) return false;
  if (normalizeForGroundingCheck(message).includes(normalizedQuote)) return true;
  return [...replyChain, ...channelHistory].some((hop) => normalizeForGroundingCheck(hop.content).includes(normalizedQuote));
}

// Filters the model's proposed historyReactions down to messageIds that
// actually exist in this turn's own <channel_history>/<reply_chain> (never
// the triggering message itself, which reactionEmoji already covers), and
// caps/dedupes defensively — the json schema already caps at 3, but a
// provider payload isn't guaranteed to honor that.
function groundHistoryReactions(
  proposed: readonly { messageId: string; emoji: string }[],
  triggeringMessageId: string | null | undefined,
  replyChain: readonly ReplyChainMessage[],
  channelHistory: readonly ChannelHistoryMessage[],
): { messageId: string; emoji: string }[] {
  const knownIds = new Set([...replyChain, ...channelHistory].map((hop) => hop.messageId));
  const seen = new Set<string>();
  const result: { messageId: string; emoji: string }[] = [];
  for (const candidate of proposed) {
    if (!candidate.emoji || candidate.messageId === triggeringMessageId) continue;
    if (!knownIds.has(candidate.messageId) || seen.has(candidate.messageId)) continue;
    seen.add(candidate.messageId);
    result.push(candidate);
    if (result.length >= 3) break;
  }
  return result;
}

function memoryKindForTopic(topic: string): "fact" | "preference" | "episode" {
  if (topic === "scene_summary") return "episode";
  if (topic === "preference") return "preference";
  return "fact";
}

export interface ChatConversationInput
  extends Omit<ChatRequest, "turnPlan" | "recentHistory" | "memories" | "guildKnowledge" | "causalChains" | "replyChainSummary" | "userCustomization" | "birthday" | "enabledTools" | "exampleExchanges" | "personaLore"> {
  guildId: string;
  // The Discord message id that triggered this turn, when there is a single
  // one (mention/ambient chat always have one; other callers may not).
  // Threaded into memoryEngine.ingest's sourceMessageId for "live"-sourced
  // writes, so a stored memory can be traced back to the message that
  // produced it. Omitted/null for turns with no single originating message
  // (e.g. dropped-exchange consolidation, which spans several).
  sourceMessageId?: string | null;
  channelHistoryEnabled?: boolean;
  canExecute?: () => Promise<boolean>;
  activityLimits?: ChatActivityLimits;
  resolveActivityLimits?: () => ChatActivityLimits;
  resolveMemoryMode?: () => ChannelMemoryMode;
  shouldDeliver?: () => boolean;
  guardedContextPort?: GuardedContextPort;
  guardedContextPolicy?: { count: number; budget: number; minReactors?: number };
  refreshContextMessage?: (event: ChannelHistoryMessage) => Promise<ChannelHistoryMessage | null>;
  afterDecision?: (response: ChatResponse) => Promise<void>;
  shadowMode?: boolean;
  // Per-guild opt-in (profile.chat.toolCallingEnabled) — whether the
  // registered tools are offered to the model for this turn at all.
  toolsEnabled?: boolean;
  // Per-guild deny-list (profile.chat.disabledTools) — tool names withheld
  // from the model even when toolsEnabled is true.
  disabledToolNames?: ReadonlySet<string>;
  // Turn-level restriction, intersected with the guild deny-list. Optional
  // participation may look up server facts without exposing action tools.
  allowedToolNames?: ReadonlySet<string>;
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

export type PlannedChatConversationInput = ChatConversationInput & { turnPlan: ActiveConversationTurnPlan };
export type GuardedChatConversationInput = PlannedChatConversationInput & { guardedContextPort: GuardedContextPort };

export class ChatStateCommitError extends Error {
  public constructor(cause: unknown) {
    super("The chat reply was delivered, but its state could not be persisted.", { cause });
    this.name = "ChatStateCommitError";
  }
}

export class ChatConversationService {
  private readonly decisionEngine = new ConversationDecisionEngine();
  private readonly scheduler: ChatScheduler;
  private readonly episodes = new ConversationEpisodes();
  private readonly opportunityVersions = new Map<string, number>();
  private nextOpportunityVersion = 0;
  private readonly recentPings = new Map<string, { at: number; messageId: string }>();
  private readonly forgottenBefore = new Map<string, number>();
  private readonly privacyVersions = new Map<string, number>();
  private readonly episodeCleanupTimer: ReturnType<typeof setInterval> | null;
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
    // Shared with ChannelSummaryScheduler and /memory. Besides persistence,
    // it supplies the per-subject mutation boundary that prevents a live or
    // background write from racing an explicit forget/member purge.
    private readonly memoryMutationCoordinator: (Pick<PersonalMemoryExtractionQueueStore, "runForSubject"> &
      Partial<Pick<PersonalMemoryExtractionQueueStore, "deleteForSubject">>) | null = null,
    private readonly episodeStore: ConversationEpisodeStore | null = null,
    private readonly characterRuntime: CharacterRuntime | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.scheduler = new ChatScheduler(this.now, undefined, undefined, undefined, this.logger);
    this.episodeCleanupTimer = episodeStore ? setInterval(() => {
      this.trackBackground(episodeStore.deleteExpired(this.now()).catch((error: unknown) =>
        this.logger?.warn({ error }, "Short-lived conversation episode cleanup failed")));
    }, 60_000) : null;
    this.episodeCleanupTimer?.unref?.();
  }

  private runMemoryMutation<T>(guildId: string, ownerUserId: string, operation: () => Promise<T>): Promise<T> {
    return this.memoryMutationCoordinator
      ? this.memoryMutationCoordinator.runForSubject(guildId, ownerUserId, operation)
      : operation();
  }

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
    context?: ChatConversationInput,
  ): ProposedMemory[] {
    const proposals: ProposedMemory[] = [];
    for (const action of userMemoryActions) {
      if (action.action === "upsert" && "sourceQuote" in action && typeof action.sourceQuote === "string" && isRecipientCorrection(action.sourceQuote)) continue;
      if (action.action === "upsert") {
        proposals.push({
          action: "upsert", audience: "private", kind: memoryKindForTopic(action.topic),
          ownerUserId: currentUserId, subjectType: "member", subjectId: action.subjectUserId,
          topic: action.topic, slot: action.slot, statement: action.statement!, channelScoped: false,
          ...("sourceQuote" in action ? { sourceQuote: action.sourceQuote as string | null } : {}),
          ...(context && "sourceQuote" in action && action.sourceQuote ? ((): Partial<Extract<ProposedMemory, { action: "upsert" }>> => {
            const quote = normalizeForGroundingCheck(action.sourceQuote as string);
            const current = action.subjectUserId === context.currentUser.id && normalizeForGroundingCheck(context.message).includes(quote);
            const original = [...context.replyChain, ...context.channelHistory].find((message) =>
              message.authorId === action.subjectUserId && normalizeForGroundingCheck(message.content).includes(quote));
            return {
              assertedByUserId: action.subjectUserId,
              observedSubjectNames: current ? [context.currentUser.displayName, context.currentUser.username,
                context.currentUser.globalName, context.currentUser.guildNickname].filter((name): name is string => Boolean(name))
                : original ? [original.authorDisplayName, original.author?.username, original.author?.globalName,
                  original.author?.guildNickname].filter((name): name is string => Boolean(name)) : [],
              sourceMessageId: current ? context.sourceMessageId ?? null : original?.messageId ?? null,
              sourceTimestampMs: current && context.currentEvent?.type === "message" ? context.currentEvent.timestampMs : original?.timestampMs ?? this.now(),
            };
          })() : {}),
          // exactOptionalPropertyTypes: a conditional spread, not
          // `importance: action.importance` — that would explicitly set
          // the key to `undefined` when action.importance is unset (the
          // main reply model's own userMemoryActions never sets it), which
          // is a real assignment under this tsconfig option, not the same
          // as omitting the property the way ProposedMemory.importance's
          // "undefined means unrated" contract expects.
          ...(action.importance !== undefined ? { importance: action.importance } : {}),
        });
      } else {
        proposals.push({
          action: "remove", ownerUserId: currentUserId, subjectType: "member",
          subjectId: action.subjectUserId, topic: action.topic, slot: action.slot,
        });
      }
    }
    for (const candidate of guildKnowledgeCandidates) {
      if ("sourceQuote" in candidate && typeof candidate.sourceQuote === "string" && isRecipientCorrection(candidate.sourceQuote)) continue;
      proposals.push({
        action: "upsert", audience: "guild", kind: memoryKindForTopic(candidate.topic),
        ownerUserId: null, subjectType: candidate.subjectType, subjectId: candidate.subjectId,
        topic: candidate.topic, slot: candidate.slot, statement: candidate.statement,
        channelScoped: candidate.channelScoped,
        ...(context && "sourceQuote" in candidate ? ((): Partial<Extract<ProposedMemory, { action: "upsert" }>> => {
          const quote = normalizeForGroundingCheck(candidate.sourceQuote as string);
          const current = normalizeForGroundingCheck(context.message).includes(quote);
          const original = [...context.replyChain, ...context.channelHistory].find((message) =>
            normalizeForGroundingCheck(message.content).includes(quote));
          return { sourceQuote: candidate.sourceQuote as string, assertedByUserId: current ? currentUserId : original?.authorId ?? null,
            sourceMessageId: current ? context.sourceMessageId ?? null : original?.messageId ?? null,
            sourceTimestampMs: current && context.currentEvent?.type === "message" ? context.currentEvent.timestampMs : original?.timestampMs ?? this.now() };
        })() : {}),
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
    canExecute?: () => Promise<boolean>,
  ): Promise<void> {
    if (droppedExchanges.length === 0) return;
    const summarizer = this.utilityProvider ?? this.provider;
    const exchangePairs = droppedExchanges.map((exchange) => ({ user: exchange.user.content, assistant: exchange.assistant.content }));
    if (summarizer.summarizeDroppedExchanges) {
      try {
        const facts = await summarizer.summarizeDroppedExchanges(exchangePairs, speaker);
        if (facts.length > 0) {
          const candidates = validateGuildKnowledgeCandidates(
            facts.filter((fact) => fact.sourceQuote && normalizeForGroundingCheck(fact.sourceQuote).length > 0 && droppedExchanges.some((exchange) =>
              exchange.user.sourceMessageId && exchange.user.channelMemoryMode && allowsDurableWrites(exchange.user.channelMemoryMode) &&
              normalizeForGroundingCheck(exchange.user.content).includes(normalizeForGroundingCheck(fact.sourceQuote!)))).map((fact) => ({
              subjectType: fact.subjectType,
              subjectId: fact.subjectType === "member" ? speaker.id : guildId,
              topic: "scene_summary",
              slot: fact.slot,
              statement: fact.statement,
              channelScoped: true,
              sourceQuote: fact.sourceQuote!,
            })),
            { guildId, currentChannelId: channelId, currentUserId: speaker.id, allowedMemberIds: new Set([speaker.id]) },
          );
          if (candidates.length > 0) {
            for (const candidate of candidates) {
              const fact = facts.find((item) => item.slot === candidate.slot && item.statement === candidate.statement);
              const source = droppedExchanges.find((exchange) => exchange.user.sourceMessageId && exchange.user.channelMemoryMode &&
                allowsDurableWrites(exchange.user.channelMemoryMode) && fact?.sourceQuote &&
                normalizeForGroundingCheck(exchange.user.content).includes(normalizeForGroundingCheck(fact.sourceQuote)));
              if (!source?.user.sourceMessageId || !source.user.channelMemoryMode || (canExecute && !await canExecute())) continue;
              const sourceMessageId = source.user.sourceMessageId;
              const sourceQuote = fact?.sourceQuote ?? "";
              const mode = source.user.channelMemoryMode === "isolated" ? "isolated" : channelMode;
              await this.runMemoryMutation(guildId, speaker.id, () => this.memoryEngine.ingest({
                guildId, channelId, channelMode: mode, assertedByUserId: speaker.id, sourceMessageId,
                source: "consolidation", now: this.now(), sourceTimestampMs: source.user.createdAt,
                proposals: this.toProposals([], [candidate], speaker.id).map((proposal) => proposal.action === "upsert" ? {
                  ...proposal, sourceQuote, supportingSources: [{ subjectId: speaker.id,
                    messageId: sourceMessageId, timestampMs: source.user.createdAt }],
                } : proposal),
              }));
            }
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
          (currentText) => evolvePersonaDrift(currentText, droppedExchanges.filter((exchange) =>
            exchange.user.channelMemoryMode === "shared" && exchange.user.sourceMessageId).map((exchange) =>
            ({ user: exchange.user.content, assistant: exchange.assistant.content }))),
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

  // Catches a specific, repeatedly-observed failure the main reply prompt's
  // own instructions don't fully prevent: crediting a real, verbatim line
  // to the wrong person. Runs on the critical path (the corrected text is
  // what actually gets delivered/stored), but only when there was other
  // people's context to misattribute against in the first place — a turn
  // with no reply_chain/channel_history has nothing to check. Failures are
  // logged and swallowed in favor of the unverified draft: a missed
  // correction is a quality regression, not a reason to not reply at all.
  private async verifyAttribution(
    draftResponse: string,
    request: ChatRequest,
  ): Promise<string> {
    const { message: currentMessage, replyChain, channelHistory, guildId, channelId } = request;
    if (replyChain.length === 0 && channelHistory.length === 0) return draftResponse;
    const verifier = this.utilityProvider?.verifyAttribution ? this.utilityProvider : this.provider;
    if (!verifier.verifyAttribution) return draftResponse;
    try {
      const context = [
        ...replyChain.map((hop) => ({ authorId: hop.authorId, authorDisplayName: hop.authorDisplayName, content: hop.content })),
        ...channelHistory.map((hop) => ({ authorId: hop.authorId, authorDisplayName: hop.authorDisplayName, content: hop.content })),
      ];
      const result = request.beforeModelAttempt ? await verifier.verifyAttribution(draftResponse, context, currentMessage, request.beforeModelAttempt)
        : await verifier.verifyAttribution(draftResponse, context, currentMessage);
      if (!result.needsCorrection) return draftResponse;
      const notes = result.correctionNotes?.trim();
      if (!notes) return draftResponse;
      // Keep the original request/persona, but never execute tools or emit previews twice.
      // Only the repaired text is consumed; all secondary output is discarded.
      const repair = await this.replyWithDiagnostics({
        ...request,
        attributionRepair: { draft: draftResponse, notes },
        enabledTools: [],
        webSearchMode: "off",
        imageGenerationEnabled: false,
        historyReactionsEnabled: false,
      });
      const corrected = stripUntrustedMarkers(repair.text);
      if (!corrected) return draftResponse;
      // A "correction" that is just the draft echoed back (often wrapped in
      // the fence markers) isn't a correction — deliver the draft untouched.
      const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
      if (normalize(corrected) === normalize(draftResponse)) return draftResponse;
      this.logger?.info({ guildId, channelId }, "Attribution verification corrected a misattributed reply");
      return corrected;
    } catch (error) {
      this.logger?.warn({ error, guildId, channelId }, "Attribution verification failed; delivering the unverified draft");
      return draftResponse;
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
    character: { prepared: CharacterPreparedTurn; reply: ChatResponse } | null = null,
  ): Promise<readonly ProposedMemoryAction[]> {
    if (isRecipientCorrection(userMessage)) return [];
    // Prefer utilityProvider only if it actually implements this capability
    // — falling back to it regardless (as resolveReplyChainSummary does)
    // would silently lose extraction if a configured utility provider lacks
    // the capability but the main provider has it.
    const extractor = this.utilityProvider?.extractPersonalMemories ? this.utilityProvider : this.provider;
    try {
      const folded = character ? await this.characterRuntime!.extractConversationMemories(userMessage, character.reply, character.prepared) : null;
      if (folded === null && !extractor.extractPersonalMemories) return [];
      const actions = folded ?? await extractor.extractPersonalMemories!(userMessage, assistantReply, speaker);
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
        .map((action) => ({
          action: action.action, topic: action.topic, slot: action.slot, statement: action.statement,
          subjectUserId: speaker.id, importance: importanceRatingToLevel(action.importance),
          sourceQuote: action.sourceQuote,
        }));
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
    character: { prepared: CharacterPreparedTurn; reply: ChatResponse } | null = null,
  ): Promise<void> {
    if (!allowsDurableWrites(input.resolveMemoryMode?.() ?? channelMode) || (input.canExecute && !await input.canExecute())) return;
    const extractedActions = await this.extractPersonalMemories(
      input.message, deliveredAssistantMessage, input.currentUser, input.guildId, input.channelId,
      character,
    );
    if (extractedActions.length === 0) return;
    const proposals = this.toProposals(extractedActions, [], input.currentUser.id, input);
    try {
      const result = await this.runMemoryMutation(input.guildId, input.currentUser.id, () => this.memoryEngine.ingest({
        guildId: input.guildId, channelId: input.channelId, channelMode: input.resolveMemoryMode?.() ?? channelMode,
        assertedByUserId: input.currentUser.id, sourceMessageId: input.sourceMessageId ?? null,
        source: /^(?:please\s+)?(?:remember\b|記住|記得|幫我記|覚えて)/iu.test(input.message.trim()) ? "explicit" : "live", now, proposals,
        ...(input.currentEvent?.type === "message" ? { sourceTimestampMs: input.currentEvent.timestampMs } : {}),
      }));
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
    const startedAt = Date.now();
    await this.characterRuntime?.drain(timeoutMs);
    timeoutMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
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
    return withDiagnosticScope({ operation: "chat_turn", guildId: input.guildId, channelId: input.channelId,
      sourceMessageId: input.sourceMessageId ?? undefined }, async () => {
      const started = performance.now();
      let textDeliveryConfirmed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      emitChatDiagnostic(this.logger, { event: "chat.turn.started", triggerMode: input.triggerMode, ...(input.candidateId ? { candidateId: input.candidateId } : {}) });
      try {
        const plan: ConversationTurnPlan | null = this.characterRuntime ? this.characterRuntime.resolveTurnPlan(input.guildId, input.channelId) : {
          state: "ready", flow: "legacy", context: "legacy", decision: "legacy", deadlineMs: null, contextPolicy: { count: 40, budget: 12000 } };
        const failure = !plan ? "profile_unavailable" : plan.state === "blocked" ? plan.reason :
          plan.context === "guarded_text" && !input.guardedContextPort ? "guard_unavailable" :
          plan.context === "legacy" && input.guardedContextPort ? "guard_mismatch" : null;
        emitChatDiagnostic(this.logger, { event: "chat.turn.plan", flow: plan?.flow ?? "legacy", context: plan?.context ?? "legacy",
          state: failure ? "blocked" : "ready", ...(failure ? { reason: failure } : {}) });
        if (failure || !plan || plan.state !== "ready") throw new SocialOutputSuppressed();
        const controller = plan.deadlineMs === null ? null : new AbortController();
        if (controller) timer = setTimeout(() => {
          emitChatDiagnostic(this.logger, { event: "chat.turn.deadline", budgetMs: plan.deadlineMs! }); controller.abort();
        }, plan.deadlineMs!);
        const planned: PlannedChatConversationInput = { ...input, turnPlan: plan,
          ...(plan.context === "guarded_text" ? { guardedContextPolicy: { ...plan.contextPolicy,
            ...(input.guardedContextPolicy?.minReactors === undefined ? {} : { minReactors: input.guardedContextPolicy.minReactors }) } } : {}) };
        const activeInput: PlannedChatConversationInput = controller ? { ...planned, turnSignal: controller.signal, turnDeadlineAt: Date.now() + plan.deadlineMs!,
          canExecute: async (): Promise<boolean> => { assertTurnActive(controller.signal); const allowed = await withTurnAbort(controller.signal, () => input.canExecute?.() ?? Promise.resolve(true)); assertTurnActive(controller.signal); return allowed; },
          shouldDeliver: (): boolean => !controller.signal.aborted && (!input.shouldDeliver || input.shouldDeliver()) } : planned;
        const response = await withTurnAbort(controller?.signal, () => this.runScheduled(activeInput, async (result) => {
          assertTurnActive(controller?.signal);
          const text = await deliver(result);
          textDeliveryConfirmed = true;
          return text;
        }, observer));
        emitChatDiagnostic(this.logger, { event: "chat.turn.completed", triggerMode: input.triggerMode,
          outcome: textDeliveryConfirmed ? "text_delivered" : "no_text_delivery", textDeliveryConfirmed, durationMs: diagnosticElapsed(started) });
        return response;
      } catch (error) {
        emitChatDiagnostic(this.logger, { event: "chat.turn.completed", triggerMode: input.triggerMode,
          outcome: error instanceof ChatStateCommitError ? "delivered_state_unsaved" : error instanceof SocialOutputSuppressed ? "suppressed" : "failed",
          textDeliveryConfirmed, durationMs: diagnosticElapsed(started), ...(error instanceof SocialOutputSuppressed ? {} : safeFailure(error)) });
        throw error;
      } finally { if (timer) clearTimeout(timer); }
    });
  }

  private admitSocialPing(input: ChatConversationInput): boolean {
    if (!input.sourceMessageId) return true;
    const key = `${input.guildId}:${input.channelId}:${input.currentUser.id}`;
    const previous = this.recentPings.get(key);
    if (previous && previous.messageId !== input.sourceMessageId && this.now() - previous.at < 10000) {
      emitChatDiagnostic(this.logger, { event: "chat.turn.skipped", reason: "duplicate_ping" }); return false;
    }
    if (this.recentPings.size >= 1024) this.recentPings.delete(this.recentPings.keys().next().value!);
    this.recentPings.set(key, { at: this.now(), messageId: input.sourceMessageId }); return true;
  }

  private runScheduled(
    input: PlannedChatConversationInput,
    deliver: (response: ChatResponse) => Promise<string>,
    observer?: ChatResponseObserver,
  ): Promise<ChatResponse> {
    const key = `${input.guildId}:${input.channelId}`;
    if (input.triggerMode === "direct" || input.triggerMode === "ambient") this.cancelOptionalOpportunity(input.guildId, input.channelId, "addressed_request");
    const optional = !resolveConversationTrigger(input).explicit;
    const expiresAt = optional ? this.now() + 30_000 : null;
    const limits = { ...(input.resolveActivityLimits?.() ?? input.activityLimits ?? balancedChatLimits), continuation: input.triggerMode === "continuation" };
    const silent: ChatResponse = {
      text: "", ambientAction: "ignore", reactionEmoji: null, historyReactions: [], userMemoryActions: [],
      guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false, generatedImages: [],
    };
    if ((input.triggerMode === "continuation" || input.triggerMode === "spontaneous") && !this.characterRuntime) {
      emitChatDiagnostic(this.logger, { event: "chat.turn.skipped", reason: "decision_unavailable" });
      return Promise.resolve(silent);
    }
    return this.scheduler.run(key, optional, limits, async () => {
      if (input.canExecute && !await input.canExecute()) {
        emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "execution_ineligible" });
        throw new SocialOutputSuppressed();
      }
      if (input.turnPlan.context === "legacy" && input.channelHistoryEnabled && this.episodeStore && (input.resolveMemoryMode?.() ?? resolveChannelMemoryMode(input.channelMemoryModes ?? {}, input.channelId)) !== "disabled") {
        const persisted = await this.episodeStore.load(input.guildId, input.channelId, this.now());
        persisted.forEach((event) => this.episodes.observe(key, event, this.now(), (this.characterRuntime?.contextWindow(input.guildId, input.channelId) ?? 15) * 60_000));
      }
      const contextVersion = this.episodes.version(key);
      const privacyVersion = this.privacyVersions.get(input.guildId) ?? 0;
      const windowMinutes = this.characterRuntime?.contextWindow(input.guildId, input.channelId);
      let snapshot = input.channelHistoryEnabled ? windowMinutes ? this.episodes.windowSnapshot(key, windowMinutes, this.now())
        : this.episodes.snapshot(key, input.currentUser.id,
        input.currentEvent?.type === "message" ? input.currentEvent.replyToMessageId : null, this.now()) : [];
      // The expanded path is rebuilt from Discord and refreshed as one batch;
      // legacy derived bot episode text has no complete provenance.
      if (input.turnPlan.context === "guarded_text") snapshot = [];
      if (input.refreshContextMessage) snapshot = (await Promise.all(snapshot.map((event) => input.refreshContextMessage!(event))))
        .filter((event): event is ChannelHistoryMessage => event !== null);
      const ids = new Set(input.replyChain.map((message) => message.messageId));
      let history = [...new Map([...input.channelHistory, ...snapshot, ...(input.currentBurst ?? [])].filter((message) =>
        !ids.has(message.messageId) && message.messageId !== input.sourceMessageId &&
        message.timestampMs > (this.forgottenBefore.get(`${input.guildId}:${message.authorId}`) ?? -Infinity)).map((message) => [message.messageId, message])).values()]
        .sort((a, b) => a.timestampMs - b.timestampMs);
      history = history.slice(windowMinutes ? -48 : -24);
      const merged = history.length;
      if (this.characterRuntime) history = this.characterRuntime.selectContext(input.guildId, input.channelId, history);
      emitChatDiagnostic(this.logger, { event: "context.selection.completed", fetchedHistory: input.channelHistory.length,
        episodeCandidates: snapshot.length, burstCandidates: input.currentBurst?.length ?? 0, merged, selected: history.length,
        replyChain: input.replyChain.length, chars: history.reduce((total, message) => total + message.content.length, 0) });
      const runTurn = input.turnPlan.context === "guarded_text" ? (turn: PlannedChatConversationInput, send: (response: ChatResponse) => Promise<string>, observe?: ChatResponseObserver): Promise<ChatResponse> => {
        if (!turn.guardedContextPort) throw new SocialOutputSuppressed();
        const guarded: GuardedChatConversationInput = { ...turn, guardedContextPort: turn.guardedContextPort };
        return this.queue.run(`${turn.guildId}:${turn.currentUser.id}`, () => withTurnAbort(turn.turnSignal, () => runGuardedChatTurn(guarded, { state: this.stateStore, runtime: this.characterRuntime,
          logger: this.logger, now: this.now, memory: this.memoryEngine, toolRegistry: this.toolRegistry,
          applicationToolsSupported: this.provider.applicationToolsSupported === true, nativeWebSearchSupported: this.provider.nativeWebSearchSupported === true, reply: (request, observer) => this.replyWithDiagnostics(request, observer),
          imageGenerationSupported: this.provider.imageGenerationSupported === true,
          repair: (text, request) => this.verifyAttribution(text, request), admitSocialPing: () => this.admitSocialPing(turn) }, send, observe))); } : this.runTurn.bind(this);
      const contextualAvailability = input.turnPlan.decision === "contextual" && (input.triggerMode === "continuation" || input.triggerMode === "spontaneous") ? {
        continuation: { text: this.scheduler.outputAvailable(key, "text", { ...limits, continuation: true }), reaction: input.historyReactionsEnabled === true && this.scheduler.outputAvailable(key, "reaction", limits) },
        spontaneous: { text: this.scheduler.outputAvailable(key, "text", { ...limits, continuation: false }), reaction: input.historyReactionsEnabled === true && this.scheduler.outputAvailable(key, "reaction", limits) },
      } : null;
      const response = await runTurn({ ...input, channelHistory: history,
        ...(contextualAvailability ? { contextualActionAvailability: contextualAvailability } : {}),
        ...((input.triggerMode === "spontaneous" || input.triggerMode === "continuation" || input.triggerMode === "reaction") ? { optionalActionsAvailable: {
          text: contextualAvailability ? contextualAvailability.continuation.text || contextualAvailability.spontaneous.text : this.scheduler.outputAvailable(key, "text", limits),
          reaction: input.historyReactionsEnabled === true && this.scheduler.outputAvailable(key, "reaction", limits),
        } } : {}),
        canExecute: async () => (this.privacyVersions.get(input.guildId) ?? 0) === privacyVersion && (!input.canExecute || await input.canExecute()),
      }, async (result) => {
        const effects = authorizeConversationEffects(result, input.sourceMessageId ?? null);
        if (effects.action !== "reply" && effects.action !== "reply_and_react") throw new SocialOutputSuppressed();
        if ((this.privacyVersions.get(input.guildId) ?? 0) !== privacyVersion) {
          emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "privacy_changed" });
          throw new SocialOutputSuppressed();
        }
        if (input.shadowMode) {
          emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "shadow" });
          await this.characterRuntime?.recordDelivery(input.guildId, input.sourceMessageId ?? null, false, true); return "";
        }
        if (result.outputOrigin !== "tool" && optional) {
          if (this.now() >= expiresAt!) {
            emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "opportunity_expired" });
            throw new SocialOutputSuppressed();
          }
          if ((input.triggerMode === "continuation" || input.triggerMode === "spontaneous") && this.episodes.version(key) !== contextVersion) {
            emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "context_changed" });
            throw new SocialOutputSuppressed();
          }
        }
        if (input.shouldDeliver && !input.shouldDeliver()) {
          emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "delivery_cancelled" });
          throw new SocialOutputSuppressed();
        }
        const release = this.scheduler.reserveOutput(key, "text", { ...(input.resolveActivityLimits?.() ?? limits),
          continuation: result.conversationDecision?.decision.participationKind ? result.conversationDecision.decision.participationKind === "continuation" : input.triggerMode === "continuation",
          exchangeId: result.participationExchangeId }, optional);
        if (!release) {
          emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "output_capacity" });
          await this.characterRuntime?.recordDelivery(input.guildId, input.sourceMessageId ?? null, false, false); throw new SocialOutputSuppressed();
        }
        try { const text = await deliver(result); release(true); await this.characterRuntime?.recordDelivery(input.guildId, input.sourceMessageId ?? null, true, false); return text; }
        catch (error) { release(false); await this.characterRuntime?.recordDelivery(input.guildId, input.sourceMessageId ?? null, false, false); throw error; }
      }, observer);
      const effects = authorizeConversationEffects(response, input.sourceMessageId ?? null);
      response.participationDecision = participationDecision(response, input.sourceMessageId ?? null, expiresAt);
      if (effects.action !== "silent" && !input.shadowMode && (!optional || this.now() < expiresAt!) &&
          (response.ambientAction === "reply" || (input.triggerMode !== "continuation" && input.triggerMode !== "spontaneous") || this.episodes.version(key) === contextVersion) &&
          (!input.shouldDeliver || input.shouldDeliver()) && (!input.canExecute || await input.canExecute()) && (!response.contextLease || await response.contextLease.validate()) && (!response.characterCanDeliver || await response.characterCanDeliver())) await input.afterDecision?.(response);
      return response;
    }, expiresAt ?? Infinity).then((result) => result ?? silent);
  }

  public observe(guildId: string, channelId: string, event: ChannelHistoryMessage): void {
    if (this.characterRuntime && !this.characterRuntime.contextAllowed(guildId, channelId)) return;
    if (event.timestampMs <= (this.forgottenBefore.get(`${guildId}:${event.authorId}`) ?? -Infinity)) return;
    const retentionMs = (this.characterRuntime?.contextWindow(guildId, channelId) ?? 15) * 60_000;
    this.episodes.observe(`${guildId}:${channelId}`, event, this.now(), retentionMs);
    this.characterRuntime?.observe(guildId, channelId, event);
    if (this.episodeStore) this.trackBackground(this.episodeStore.observe(guildId, channelId, event, this.now(), retentionMs).catch((error: unknown) =>
      this.logger?.warn({ error, guildId, channelId }, "Failed to persist short-lived conversation episode")));
  }

  private recordContextForget: ((guildId: string, userId: string, cutoff: number) => Promise<void>) | null = null;
  public bindContextForgetRecorder(record: (guildId: string, userId: string, cutoff: number) => Promise<void>): void { this.recordContextForget = record; }

  public async forgetConversation(guildId: string, userId: string): Promise<void> {
    for (const key of this.opportunityVersions.keys()) if (key.startsWith(`${guildId}:`)) this.cancelOptionalOpportunity(guildId, key.slice(guildId.length + 1), "privacy_changed");
    this.characterRuntime?.forget(guildId, userId);
    if (this.forgottenBefore.size >= 1000) this.forgottenBefore.delete(this.forgottenBefore.keys().next().value!);
    this.forgottenBefore.set(`${guildId}:${userId}`, this.now());
    this.privacyVersions.set(guildId, (this.privacyVersions.get(guildId) ?? 0) + 1);
    this.episodes.forget(guildId, userId);
    const contextCleanup = Promise.resolve().then(() => this.recordContextForget?.(guildId, userId, this.now())).then(() => true, () => false);
    // Traces can reference multiple participants. Drop this guild's bounded
    // diagnostic cache and reject late events from pre-forget scopes.
    const diagnosticCleanup = diagnosticStore(this.logger)?.forgetGuild(guildId, currentDiagnosticTraceSequence()).then(() => true, () => false) ?? Promise.resolve(true);
    await this.drain();
    await this.episodeStore?.forgetUser(guildId, userId);
    if (this.stateStore.clearRecentHistory) await this.stateStore.clearRecentHistory(guildId, userId);
    else await this.stateStore.purgeUser(guildId, userId);
    if (!await contextCleanup) throw new Error("Conversation data was cleared, but durable context invalidation failed");
    if (!await diagnosticCleanup) throw new Error("Conversation data was cleared, but diagnostic retention cleanup failed");
  }

  public excludeInteraction(guildId: string, channelId: string, messageId: string): void {
    this.cancelOptionalOpportunity(guildId, channelId, "source_invalidated");
    this.characterRuntime?.excludeContext(guildId, messageId);
    this.episodes.excludeInteraction(`${guildId}:${channelId}`, messageId);
    const traces = diagnosticStore(this.logger);
    if (traces) {
      traces.excludeSource({ guildId, channelId, sourceMessageId: messageId }, currentDiagnosticTraceSequence());
      // The store coalesces snapshot writes. Per-edit flush promises would
      // create an unbounded waiter queue during rapid control-panel updates.
    }
    if (this.episodeStore) this.trackBackground(this.episodeStore.exclude(guildId, channelId, messageId).catch((error: unknown) =>
      this.logger?.warn({ error, guildId, channelId }, "Failed to exclude a utility interaction from stored context")));
  }

  public hasRecentConversation(guildId: string, channelId: string, authorId: string, botId: string): boolean {
    return this.episodes.hasRecentConversation(`${guildId}:${channelId}`, authorId, botId, this.now());
  }
  public get optionalDecisionAvailable(): boolean { return this.characterRuntime?.decisionAvailable ?? false; }
  public optionalEvaluationDelayMs(guildId: string, channelId: string, limits: ChatActivityLimits): number {
    return this.scheduler.evaluationDelayMs(`${guildId}:${channelId}`, limits);
  }
  public isImplicitlyAddressed(guildId: string, channelId: string, event: ChannelHistoryMessage, botId: string): boolean {
    return this.characterRuntime?.couldBeAddressed(guildId, channelId, event, this.episodes.windowSnapshot(`${guildId}:${channelId}`, 2, this.now()), botId) ?? false;
  }

  public optionalOpportunityVersion(guildId: string, channelId: string): number {
    const key = `${guildId}:${channelId}`;
    let version = this.opportunityVersions.get(key);
    if (version === undefined) {
      if (this.opportunityVersions.size >= 256) {
        const oldest = this.opportunityVersions.keys().next().value!;
        this.scheduler.cancelBufferedOpportunity(oldest, "capacity"); this.opportunityVersions.delete(oldest);
      }
      version = ++this.nextOpportunityVersion; this.opportunityVersions.set(key, version);
    }
    return version;
  }
  public cancelOptionalOpportunity(guildId: string, channelId: string, reason: OpportunityCancellationReason = "cancelled"): void {
    const key = `${guildId}:${channelId}`;
    this.optionalOpportunityVersion(guildId, channelId);
    this.opportunityVersions.set(key, ++this.nextOpportunityVersion);
    this.scheduler.cancelBufferedOpportunity(key, reason);
  }

  public bufferOpportunity(guildId: string, channelId: string, job: () => void): void {
    this.scheduler.bufferOpportunity(`${guildId}:${channelId}`, job);
  }

  public reserveReaction(guildId: string, channelId: string, limits = balancedChatLimits): ((success: boolean) => void) | null {
    return this.scheduler.reserveOutput(`${guildId}:${channelId}`, "reaction", limits, true);
  }
  public runCallback(guildId: string, channelId: string, limits: ChatActivityLimits, operation: () => Promise<boolean>): Promise<boolean> {
    return this.scheduler.run(`${guildId}:${channelId}`, true, { ...limits, continuation: false }, async () => {
      const release = this.scheduler.reserveOutput(`${guildId}:${channelId}`, "text", { ...limits, continuation: false }, true);
      if (!release) return false;
      try { const sent = await operation(); release(sent); return sent; } catch (error) { release(false); throw error; }
    }, this.now() + 30_000).then((result) => result ?? false);
  }
  public runCharacterEvaluation<T>(guildId: string, channelId: string, limits: ChatActivityLimits, operation: () => Promise<T>, cost = 1): Promise<T | null> {
    // Synthetic probes share guild admission/concurrency but never reserve a
    // public output or use a channel's spontaneous text cooldown.
    return this.scheduler.run(`${guildId}:evaluation-${channelId}`, true, { ...limits, continuation: false, optionalCallCost: cost }, operation);
  }

  public stopScheduling(): void {
    this.characterRuntime?.stop();
    this.scheduler.stop();
    if (this.episodeCleanupTimer) clearInterval(this.episodeCleanupTimer);
  }

  private async replyWithDiagnostics(request: ChatRequest, observer?: ChatResponseObserver): Promise<ChatResponse> {
    const started = performance.now();
    const purpose = request.attributionRepair ? "repair" : request.participationOnly ? "participation" : "reply";
    try {
      const response = purpose === "reply" ? await this.provider.reply(request, observer) : await this.provider.reply(request);
      emitChatDiagnostic(this.logger, { event: "chat.model.completed", purpose, status: "valid", durationMs: diagnosticElapsed(started) });
      return response;
    } catch (error) {
      emitChatDiagnostic(this.logger, { event: "chat.model.completed", purpose, status: "failed", durationMs: diagnosticElapsed(started), ...safeFailure(error) });
      throw error;
    }
  }

  private runTurn(
    input: PlannedChatConversationInput,
    deliver: (response: ChatResponse) => Promise<string>,
    observer?: ChatResponseObserver,
  ): Promise<ChatResponse> {
    const key = `${input.guildId}:${input.currentUser.id}`;
    const channelMode = input.resolveMemoryMode?.() ?? resolveChannelMemoryMode(input.channelMemoryModes ?? {}, input.channelId);
    let characterPrepared: CharacterPreparedTurn | null = null;
    let functionalToolExecuted = false;
    const functionalResults: string[] = [];
    const canContinue = async (): Promise<boolean> => (!input.resolveMemoryMode || input.resolveMemoryMode() === channelMode) &&
      (functionalToolExecuted || !characterPrepared || await this.characterRuntime!.validatePrepared(characterPrepared)) &&
      (!input.canExecute || await input.canExecute());
    return this.queue.run(key, async () => {
      if (!await canContinue()) throw new SocialOutputSuppressed();
      const now = this.now();
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
      let resolveExtractionInput!: (value: { assistantMessage: string; character: { prepared: CharacterPreparedTurn; reply: ChatResponse } | null } | null) => void;
      const extractionInput = new Promise<{ assistantMessage: string; character: { prepared: CharacterPreparedTurn; reply: ChatResponse } | null } | null>((resolve) => {
        resolveExtractionInput = resolve;
      });
      if (allowsDurableWrites(channelMode) && input.triggerMode !== "reaction") {
        this.trackBackground(this.queue.run(key, async () => {
          const ready = await extractionInput;
          if (!ready) return;
          await this.extractAndIngestPersonalMemories(input, ready.assistantMessage, channelMode, now, ready.character);
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
      const state = input.triggerMode === "reaction" ? { exchanges: [], memories: [] }
        : await this.stateStore.load(input.guildId, input.currentUser.id, input.channelId, now);
      const recentHistory = this.promptHistorySelector.select(state.exchanges);
      const replyToContent = input.replyChain.at(-1)?.content;
      // Never rejects (failures resolve to null), so lore selection can
      // chain on it without risking the whole Promise.all.
      const replyChainSummaryPromise = this.resolveReplyChainSummary(
        input.replyChainOverflow ?? [], input.guildId, input.channelId,
      );
      // Recall and both persona selectors run concurrently and embed the
      // same query text (see buildEmbeddingQueryText), which the shared
      // CachingEmbeddingsClient collapses into one embeddings call.
      const [
        memoryContext, userCustomization, birthday, replyChainSummary, selectedExampleExchanges, selectedPersonaLore,
      ] = await Promise.all([
        this.memoryEngine.recall({
          guildId: input.guildId,
          channelId: input.channelId,
          userId: input.currentUser.id,
          message: input.message,
          recentHistory,
          ...(replyToContent !== undefined ? { replyToContent } : {}),
          subjectIds: [input.currentUser.id, ...input.mentionedUsers.map((user) => user.id)],
          now,
          channelMode,
        }),
        input.triggerMode === "reaction" ? Promise.resolve(null) : this.userCustomizationStore?.load(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
        input.triggerMode === "reaction" ? Promise.resolve(null) : this.birthdayStore?.getBirthday(input.guildId, input.currentUser.id) ?? Promise.resolve(null),
        replyChainSummaryPromise,
        this.exampleExchangeSelector.select({
          records: input.examplePool,
          currentUser: input.currentUser,
          mentionedUsers: input.mentionedUsers,
          recentHistory,
          message: input.message,
          now,
          replyChain: input.replyChain,
        }),
        replyChainSummaryPromise.then((summary) => this.personaLoreSelector.select({
          chunks: input.loreChunks,
          recentHistory,
          message: input.message,
          now,
          replyChain: input.replyChain,
          replyChainSummary: summary,
        })),
      ]);
      const promptSources = await this.memoryEngine.listPromptSources?.(memoryContext.memories.filter((memory) => memory.subjectType === "member").map((memory) => memory.id)) ?? [];
      let memoryChars = 0;
      const budget = memoryContext.maxSerializedChars ?? 8_000;
      const fitsBudget = (record: ChatMemoryRecord | GuildKnowledgeRecord): boolean => {
        const size = JSON.stringify({ ...record, embedding: null }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").length * 2 + 128;
        if (memoryChars + size > budget) return false;
        memoryChars += size; return true;
      };
      const selectedMemories = memoryContext.memories.filter((memory) => memory.subjectType === "member")
        .map((memory): ChatMemoryRecord => {
          const sources = promptSources.filter((source) => source.memoryId === memory.id).slice(0, 2);
          return {
            ...toChatMemoryRecord(memory), audience: memory.audience,
            observedSubjectNames: observedSubjectNames(memory),
            assertedByUserId: sources.find((source) => source.assertedByUserId === memory.subjectId)?.assertedByUserId
              ?? sources.at(-1)?.assertedByUserId ?? memory.ownerUserId ?? "unknown",
            sourceEvidence: sources.map((source) => ({ messageId: source.sourceMessageId, channelId: source.sourceChannelId,
              assertedByUserId: source.assertedByUserId, quote: source.sourceQuote?.slice(0, 350) ?? null,
              timestampMs: source.sourceTimestampMs ?? null, observedAt: source.createdAt })),
          };
        }).filter(fitsBudget);
      const selectedGuildKnowledge = memoryContext.memories.filter((memory) => memory.subjectType !== "member").map(toGuildKnowledgeRecord).filter(fitsBudget);
      // examplePool/loreChunks are the unfiltered candidate lists — only
      // their selector-narrowed results belong in the request, so they're
      // destructured out here purely to keep them off requestInput's spread
      // below.
      const {
        toolsEnabled, disabledToolNames, allowedToolNames, examplePool, loreChunks, personaDriftEnabled, replyChainOverflow,
        personalitySourceHash, ...requestInput
      } = input;
      void personaDriftEnabled;
      void examplePool;
      void loreChunks;
      void replyChainOverflow;
      void personalitySourceHash;
      const capabilities = effectiveChatCapabilities({ ...input, toolsEnabled: toolsEnabled === true }, { guarded: false,
        nativeWebSearchSupported: this.provider.nativeWebSearchSupported === true, shadow: input.shadowMode ?? false });
      let request: ChatRequest = {
        characterShadow: input.shadowMode ?? false,
        characterStyleExamples: input.examplePool,
        characterPersonaHash: input.personalitySourceHash ?? hashContent(input.personality),
        ...requestInput,
        webSearchMode: capabilities.webSearchMode,
        imageGenerationEnabled: capabilities.imageGenerationEnabled,
        recentHistory,
        channelMode,
        memories: selectedMemories,
        replyChainSummary,
        guildKnowledge: selectedGuildKnowledge,
        causalChains: memoryContext.causalChains,
        ...(memoryContext.aliasCandidates?.length ? { aliasCandidates: memoryContext.aliasCandidates } : {}),
        exampleExchanges: selectedExampleExchanges.map((exchange) => (
          { tags: exchange.tags, user: exchange.user, character: exchange.character }
        )),
        personaLore: selectedPersonaLore.map((chunk) => ({ heading: chunk.heading, text: chunk.text })),
        userCustomization,
        birthday: birthday ? { month: birthday.month, day: birthday.day, birthYear: birthday.birthYear } : null,
        enabledTools: capabilities.toolsEnabled && this.toolRegistry
          ? this.toolRegistry.list().filter((tool) => !disabledToolNames?.has(tool.name) && (!allowedToolNames || allowedToolNames.has(tool.name))).map((tool) => ({
              name: tool.name, description: tool.description, parameters: tool.parameters,
              execute: async (args, context): ReturnType<ChatTool["execute"]> => {
                if (!await canContinue()) throw new SocialOutputSuppressed();
                if (tool.outputKind !== "context") { functionalToolExecuted = true; request.functionalToolExecuted = true; }
                const result = await tool.execute(args, { ...context, knownSubjectIds: [input.currentUser.id,
                  ...input.mentionedUsers.map((user) => user.id), ...input.replyChain.map((message) => message.authorId),
                  ...(memoryContext.aliasCandidates?.filter((alias) => alias.subjectIds.length === 1).flatMap((alias) => alias.subjectIds) ?? [])] });
                if (tool.outputKind !== "context") functionalResults.push(result.content);
                return result;
              },
            }))
          : [],
      };
      if (this.characterRuntime) {
        characterPrepared = await this.characterRuntime.prepare(request);
        if (characterPrepared) {
          request = characterPrepared.request;
          if (!characterPrepared.allowed) return { ...(characterPrepared.conversationDecision ? { conversationDecision: characterPrepared.conversationDecision } : {}), text: "", ambientAction: "ignore", reactionEmoji: null, historyReactions: [],
            userMemoryActions: [], guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false, generatedImages: [] };
        }
      }
      if (characterPrepared?.conversationDecision?.recovery === "grounded_reply") request = { ...request, enabledTools: [], imageGenerationEnabled: false, webSearchMode: "off",
        characterContext: [...(request.characterContext ?? []), { moduleId: "participation", text: "The participation decision failed. This is a narrowly authorized same-person continuation. Answer or clarify only the supplied current exchange and its proven branch. No tools, image generation, web search, new actions, or invented context." }] };
      if (!await canContinue()) throw new SocialOutputSuppressed();
      if (characterPrepared?.participation?.action === "ignore" && !input.shadowMode) return {
        ...(characterPrepared.conversationDecision ? { conversationDecision: characterPrepared.conversationDecision } : {}),
        text: "", ambientAction: "ignore", reactionEmoji: characterPrepared.participation.reaction, historyReactions: [], userMemoryActions: [],
        guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false, generatedImages: [],
        ...(characterPrepared.targetMessageId ? { replyTargetMessageId: characterPrepared.targetMessageId } : {}),
        characterIsCurrent: () => this.characterRuntime!.stillEligible(characterPrepared!),
        characterCanDeliver: () => this.characterRuntime!.validatePrepared(characterPrepared!),
      };
      const needsParticipationFirst = !resolveConversationTrigger(input).explicit && !input.shadowMode &&
        (Boolean(request.enabledTools?.length) || request.imageGenerationEnabled || request.webSearchMode === "auto");
      let response: ChatResponse;
      if (needsParticipationFirst && !characterPrepared?.participation) {
        response = await this.replyWithDiagnostics({ ...request, participationOnly: true,
          capabilityToolNames: request.enabledTools?.map((tool) => tool.name) ?? [],
          enabledTools: [], imageGenerationEnabled: false, webSearchMode: "off" });
        const assessment = this.decisionEngine.finalize(request, response, this.now(), characterPrepared?.fingerprint);
        if (assessment.status === "failed") return { ...response, text: "", ambientAction: "ignore", reactionEmoji: null, historyReactions: [], userMemoryActions: [], guildKnowledgeCandidates: [], conversationDecision: assessment };
        if (assessment.decision.action === "reply" || assessment.decision.action === "reply_and_react") {
          if (!await canContinue()) throw new SocialOutputSuppressed();
          response = await this.replyWithDiagnostics(request, observer);
        }
      } else response = await this.replyWithDiagnostics(request, observer);
      if (response.generatedImages.length > 0) functionalToolExecuted = true;
      if (!await canContinue()) throw new SocialOutputSuppressed();
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
        ...(input.currentBurst ?? []).map((event) => event.authorId),
      ]);
      const validatedResponse = {
        ...response,
        outputOrigin: functionalToolExecuted ? "tool" as const : "chat" as const,
        contextUsage: {
          personalityChars: input.personality.length,
          personaLoreChars: JSON.stringify(selectedPersonaLore).length,
          userCustomizationChars: userCustomization?.length ?? 0,
          securityInstructionChars: chatSafetyGuard.length,
          memoryInstructionChars: chatMemoryInstructions.length + guildKnowledgeInstructions.length,
          historyMessages: recentHistory.length,
          historyChars: JSON.stringify(recentHistory).length,
          memoryRecords: selectedMemories.length,
          memoryChars: promptSizeOf(selectedMemories),
          guildKnowledgeRecords: selectedGuildKnowledge.length,
          guildKnowledgeChars: promptSizeOf(selectedGuildKnowledge),
          exampleExchangeRecords: selectedExampleExchanges.length,
          exampleExchangeChars: JSON.stringify(selectedExampleExchanges).length,
          replyChainMessages: input.replyChain.length,
          replyChainChars: JSON.stringify(input.replyChain).length,
          channelHistoryMessages: input.channelHistory.length,
          channelHistoryChars: JSON.stringify(input.channelHistory).length,
          currentMessageChars: input.message.length,
        },
        // Grounding runs after (not instead of) the existing topic/slot/
        // subject-authorization validation above — a proposal can pass that
        // and still be an ungrounded misattribution, which is exactly what
        // this catches: a "remove" action needs no grounding (nothing new to
        // ground), an "upsert" must quote something its own subject actually
        // said this turn.
        userMemoryActions: validateMemoryActions(response.userMemoryActions, allowedSubjects).filter((action) => !isRecipientCorrection(input.message) && (
          action.action === "remove" || isGroundedForSpeaker(
            action.sourceQuote, action.subjectUserId, input.message, input.currentUser.id, input.replyChain, input.channelHistory,
          ))),
        guildKnowledgeCandidates: validateGuildKnowledgeCandidates(
          response.guildKnowledgeCandidates,
          {
            guildId: input.guildId,
            currentChannelId: input.channelId,
            currentUserId: input.currentUser.id,
            allowedMemberIds: allowedSubjects,
          },
        ).filter((candidate) => candidate.subjectType === "member"
          ? isGroundedForSpeaker(
              candidate.sourceQuote, candidate.subjectId, input.message, input.currentUser.id, input.replyChain, input.channelHistory,
            )
          : isGroundedAnywhere(candidate.sourceQuote, input.message, input.replyChain, input.channelHistory)),
        historyReactions: groundHistoryReactions(
          response.historyReactions, input.sourceMessageId, input.replyChain, input.channelHistory,
        ),
      };
      if (input.shadowMode) {
        const shadowDecision = this.decisionEngine.finalize(request, validatedResponse, this.now(), characterPrepared?.fingerprint, characterPrepared?.conversationDecision);
        reportConversationDecision(this.logger, shadowDecision, "generation", resolveConversationTrigger(input).interaction);
        this.logger?.info({ guildId: input.guildId, channelId: input.channelId, sourceMessageId: input.sourceMessageId,
          triggerMode: input.triggerMode, action: validatedResponse.ambientAction, reaction: validatedResponse.reactionEmoji !== null,
          hasParticipationReason: Boolean(validatedResponse.participationReason),
          contextMessages: input.channelHistory.length + input.replyChain.length }, "Shadow participation decision");
        return { ...validatedResponse, conversationDecision: shadowDecision, userMemoryActions: [], guildKnowledgeCandidates: [] };
      }
      if (functionalToolExecuted || input.triggerMode === "reaction") {
        validatedResponse.userMemoryActions = [];
        validatedResponse.guildKnowledgeCandidates = [];
      }
      if (functionalToolExecuted) {
        validatedResponse.conversationDecision = this.decisionEngine.finalize({ ...request, functionalToolExecuted: true }, validatedResponse, this.now(), characterPrepared?.fingerprint);
        reportConversationDecision(this.logger, validatedResponse.conversationDecision, "generation", resolveConversationTrigger(input).interaction);
        if (characterPrepared && !await this.characterRuntime!.validatePrepared(characterPrepared) && functionalResults.length) validatedResponse.text = functionalResults.join("\n");
        validatedResponse.ambientAction = "reply";
        validatedResponse.reactionEmoji = null;
        validatedResponse.historyReactions = [];
        validatedResponse.contextProvenance = allowsDurableWrites(channelMode) ? captureIncompleteTurnProvenance(request, validatedResponse.text) : null;
        await deliver(validatedResponse);
        return validatedResponse;
      }
      // ambientAction "ignore" and reactionEmoji are independent signals:
      // a non-direct turn (ambient or reaction) can reply, react, both, or
      // neither. No reply here (ambientAction !== "reply") means `deliver`
      // is never called; if a reaction is still set, the model engaged (if
      // only with an emoji) and may have picked up something memory-worthy,
      // so persist via memoryEngine.ingest (no session exchange — there's
      // no assistant reply text to record). Fully ignored (no reply, no
      // reaction) means no reply, no memory write, no guild-knowledge
      // write. The caller (AmbientChatBehavior/ReactionReplyScheduler)
      // inspects ambientAction/reactionEmoji on the returned response to
      // react or no-op.
      const proposals = isRecipientCorrection(input.message) ? [] : this.toProposals(
        validatedResponse.userMemoryActions, validatedResponse.guildKnowledgeCandidates, input.currentUser.id,
        input,
      );
      const decisionResult = this.decisionEngine.finalize(request, validatedResponse, this.now(), characterPrepared?.fingerprint, characterPrepared?.conversationDecision);
      validatedResponse.conversationDecision = decisionResult;
      if (resolveConversationTrigger(input).explicit && (validatedResponse.responseIntent === "social" || validatedResponse.responseIntent === "closing") && input.sourceMessageId) {
        const pingKey = `${input.guildId}:${input.channelId}:${input.currentUser.id}`;
        const previous = this.recentPings.get(pingKey);
        if (previous && previous.messageId !== input.sourceMessageId && this.now() - previous.at < 10_000) {
          decisionResult.status = "denied"; decisionResult.decision.action = "silent"; decisionResult.decision.reasonCode = "duplicate_ping";
          validatedResponse.reactionEmoji = null; validatedResponse.historyReactions = [];
          emitChatDiagnostic(this.logger, { event: "chat.turn.skipped", reason: "duplicate_ping" });
        } else {
          if (this.recentPings.size >= 1024) this.recentPings.delete(this.recentPings.keys().next().value!);
          this.recentPings.set(pingKey, { at: this.now(), messageId: input.sourceMessageId });
        }
      }
      if (decisionResult.recovery === "error_reply") {
        reportConversationDecision(this.logger, decisionResult, "generation", resolveConversationTrigger(input).interaction);
        throw new ChatProviderError("Invalid contextual response evidence", 502, "invalid_structured_output");
      }
      if (decisionResult.status === "failed" && decisionResult.decision.action === "silent") {
        validatedResponse.reactionEmoji = null; validatedResponse.historyReactions = [];
        validatedResponse.userMemoryActions = []; validatedResponse.guildKnowledgeCandidates = [];
      }
      const mayIgnore = decisionResult.decision.action === "silent" || decisionResult.decision.action === "react";
      if (mayIgnore) { validatedResponse.ambientAction = "ignore"; validatedResponse.text = ""; }
      else validatedResponse.ambientAction = "reply";
      if (mayIgnore && validatedResponse.ambientAction !== "reply") {
        reportConversationDecision(this.logger, decisionResult, "generation", resolveConversationTrigger(input).interaction);
        if (validatedResponse.reactionEmoji && proposals.length > 0) {
          try {
            const result = await this.runMemoryMutation(input.guildId, input.currentUser.id, () => this.memoryEngine.ingest({
              guildId: input.guildId, channelId: input.channelId, channelMode,
              assertedByUserId: input.currentUser.id, sourceMessageId: input.sourceMessageId ?? null,
              source: /^(?:please\s+)?(?:remember\b|記住|記得|幫我記|覚えて)/iu.test(input.message.trim()) ? "explicit" : "live", now, proposals,
            }));
            this.logMemoryIngestIssues(result, input.guildId, input.channelId, input.currentUser.id);
          } catch (error) {
            throw new ChatStateCommitError(error);
          }
        }
        return validatedResponse;
      }
      validatedResponse.ambientAction = "reply";
      // Mutates the already-built response object in place (not a
      // reassignment) — everything below this point (delivery, session-
      // exchange storage, dedicated personal-memory extraction on the
      // delivered text) reads validatedResponse.text, so correcting it here
      // is the one place that guarantees every downstream consumer sees the
      // corrected version rather than some seeing the draft.
      validatedResponse.text = await this.verifyAttribution(
        validatedResponse.text, request,
      );
      if (characterPrepared && !input.shadowMode) {
        const previousText = validatedResponse.text;
        Object.assign(validatedResponse, await this.characterRuntime!.process(validatedResponse, characterPrepared));
        if (validatedResponse.text !== previousText) {
          const corrected = await this.verifyAttribution(validatedResponse.text, request);
          if (corrected !== validatedResponse.text) { delete validatedResponse.characterMessages; delete validatedResponse.characterDelayMs; }
          validatedResponse.text = corrected;
        }
      }
      const finalDecision = this.decisionEngine.finalize(request, validatedResponse, this.now(), characterPrepared?.fingerprint, decisionResult);
      validatedResponse.conversationDecision = finalDecision;
      reportConversationDecision(this.logger, finalDecision, "generation", resolveConversationTrigger(input).interaction);
      if (finalDecision.recovery === "error_reply") throw new ChatProviderError("Invalid contextual response", 502, "invalid_structured_output");
      const finalSilent = finalDecision.decision.action === "silent" || finalDecision.decision.action === "react";
      if (finalSilent) { validatedResponse.ambientAction = "ignore"; validatedResponse.text = ""; delete validatedResponse.characterMessages; delete validatedResponse.characterDelayMs; }
      if (finalSilent) {
        await this.characterRuntime?.recordDelivery(input.guildId, input.sourceMessageId ?? null, false, input.shadowMode ?? false);
        return validatedResponse;
      }
      if (!await canContinue()) throw new SocialOutputSuppressed();
      validatedResponse.contextProvenance = allowsDurableWrites(channelMode) ? captureIncompleteTurnProvenance(request, validatedResponse.text) : null;
      const deliveredAssistantMessage = await deliver(validatedResponse);
      if (input.shadowMode) return validatedResponse;
      if (input.triggerMode === "reaction") return validatedResponse;
      // Signals the extraction sub-task (reserved at the very top of this
      // callback) that it can proceed — see that reservation's own comment
      // for why the slot is claimed before this point rather than here.
      resolveExtractionInput(allowsDurableWrites(channelMode) ? { assistantMessage: deliveredAssistantMessage,
        character: characterPrepared ? { prepared: characterPrepared, reply: validatedResponse } : null } : null);
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
          contextProvenance: validatedResponse.contextProvenance ?? null,
          assistantMessageIds: (validatedResponse.characterDeliveryProof ?? []).map((part) => part.messageId).slice(0, 32),
          sourceMessageId: input.sourceMessageId ?? null, channelMemoryMode: channelMode,
          ...(input.currentEvent?.type === "message" ? { sourceTimestampMs: input.currentEvent.timestampMs } : {}),
          actions: [],
          now,
        });
        droppedExchanges = result.droppedExchanges;
      } catch (error) {
        throw new ChatStateCommitError(error);
      }
      if (proposals.length > 0) {
        try {
          if (proposals.some((proposal) => proposal.action === "remove")) {
            await this.memoryMutationCoordinator?.deleteForSubject?.(input.guildId, input.currentUser.id);
          }
          const result = await this.runMemoryMutation(input.guildId, input.currentUser.id, () => this.memoryEngine.ingest({
            guildId: input.guildId, channelId: input.channelId, channelMode,
            assertedByUserId: input.currentUser.id, sourceMessageId: input.sourceMessageId ?? null,
            source: /^(?:please\s+)?(?:remember\b|記住|記得|幫我記|覚えて)/iu.test(input.message.trim()) ? "explicit" : "live", now, proposals,
          }));
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
        input.canExecute,
      ).catch((error: unknown) => {
        this.logger?.warn({ error, guildId: input.guildId, channelId: input.channelId }, "Dropped-exchange consolidation failed unexpectedly");
      }));
      if (characterPrepared && !input.shadowMode) this.trackBackground(this.characterRuntime!.consolidate(validatedResponse, characterPrepared).catch((error: unknown) =>
        this.logger?.warn({ error, guildId: input.guildId }, "Character consolidation failed")));
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
