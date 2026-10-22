import { runGuardedChatTurn } from "./guarded-chat-turn.js";
import { runGuardedPostTurn } from "./guarded-post-turn.js";
import { ConversationModelGateway } from "../context/conversation-model-gateway.js";
import { repairConversationRequest } from "../context/approved-conversation-request.js";
import { authorizeConversationEffects } from "./conversation-effects.js";
import type { ActiveConversationTurnPlan, ConversationTurnPlan } from "./conversation-turn-plan.js";
import { assertTurnActive, withTurnAbort } from "./turn-work-budget.js";
import type { GuardedContextPort } from "./guarded-conversation-context.js";
import type { Logger } from "pino";
import { performance } from "node:perf_hooks";
import { currentDiagnosticTraceSequence, diagnosticElapsed, diagnosticStore, emitChatDiagnostic, safeFailure, withDiagnosticScope } from "../diagnostics/chat-diagnostics.js";
import type { CharacterRuntime } from "./character-runtime.js";

import { stripUntrustedMarkers } from "./attribution-verification.js";
import { type ChannelHistoryMessage, type ChatProvider, type ChatRequest, type ChatResponse, type ChatResponseObserver, type ReplyChainMessage } from "./chat-provider.js";
import type { ChatStateStore } from "./chat-state-store.js";
import type { UserCustomizationStore } from "./user-customization-store.js";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import { ChatScheduler, balancedChatLimits, type ChatActivityLimits, type OpportunityCancellationReason } from "./chat-scheduler.js";
import { ConversationEpisodes } from "./conversation-episodes.js";
import { resolveConversationTrigger } from "./conversation-trigger.js";
import { isExplicitInteraction, isOptionalInteraction } from "./chat-policy.js";
import type { ConversationEpisodeStore } from "./conversation-episode-store.js";
import { participationDecision } from "./participation-decision.js";
import { RecentPromptHistorySelector, type PromptHistorySelector } from "./prompt-history-selector.js";
import { RelevantExampleExchangeSelector, type ExampleExchangeSelector } from "./example-exchange-selector.js";
import { RelevantPersonaLoreSelector, type PersonaLoreSelector } from "./persona-lore-selector.js";
import type { PersonaDriftStore } from "./persona-drift-store.js";
import type { ExampleExchange } from "./example-exchange.js";
import type { PersonaLoreChunk } from "./persona-source.js";
import type { BirthdayStore } from "../birthdays/birthday-store.js";
import type { ChatToolRegistry } from "./tools/chat-tool-registry.js";
import { type ChannelMemoryMode } from "../memory/memory-channel-policy.js";
import type { MemoryEngine } from "../memory/memory.js";
import type { PersonalMemoryExtractionQueueStore } from "../context/personal-memory-extraction-queue.js";

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
  // Compatibility-only input, ignored. Registered source ancestry owns overflow.
  replyChainOverflow?: readonly ReplyChainMessage[];
  // Compatibility-only pools; live selection uses registered configuration.
  examplePool: readonly ExampleExchange[];
  loreChunks: readonly PersonaLoreChunk[];
  // Per-channel memory isolation mode, keyed by channel id — resolved from
  // guild configuration by the caller (not looked up here, keeping this
  // service decoupled from the config schema). Omitted/missing channel
  // entries default to "shared" (today's behavior) — see
  // resolveChannelMemoryMode. Wiring an actual admin-configurable source for
  // this map is a follow-up (a `channelMemoryModes` guild-config field plus
  // a setup setting) — until then every channel behaves exactly as before.
  channelMemoryModes?: Readonly<Record<string, ChannelMemoryMode>>;
  // Source-backed, channel-scoped drift learning only.
  personaDriftEnabled?: boolean;
  // Compatibility-only; guarded processing uses the registered persona hash.
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
  private readonly conversationModels: ConversationModelGateway;
  private readonly scheduler: ChatScheduler;
  private readonly episodes = new ConversationEpisodes();
  private readonly opportunityVersions = new Map<string, number>();
  private nextOpportunityVersion = 0;
  private readonly recentPings = new Map<string, { at: number; messageId: string }>();
  private readonly forgottenBefore = new Map<string, number>();
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
    _promptHistorySelector: PromptHistorySelector = new RecentPromptHistorySelector(),
    private readonly exampleExchangeSelector: ExampleExchangeSelector = new RelevantExampleExchangeSelector(),
    private readonly personaLoreSelector: PersonaLoreSelector = new RelevantPersonaLoreSelector(),
    private readonly userCustomizationStore: UserCustomizationStore | null = null,
    _birthdayStore: BirthdayStore | null = null,
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
    this.conversationModels = new ConversationModelGateway(this.utilityProvider ?? this.provider, this.provider);
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

  private async verifyAttribution(
    draftResponse: string,
    request: ChatRequest,
  ): Promise<string> {
    const { guildId, channelId } = request;
    try {
      const result = await this.conversationModels.verifyAttribution(request, draftResponse);
      if (!result?.needsCorrection) return draftResponse;
      const notes = result.correctionNotes?.trim();
      if (!notes) return draftResponse;
      // Keep the original request/persona, but never execute tools or emit previews twice.
      // Only the repaired text is consumed; all secondary output is discarded.
      const repair = await this.replyWithDiagnostics(repairConversationRequest(request, draftResponse, notes));
      const corrected = stripUntrustedMarkers(repair.text);
      if (!corrected) return draftResponse;
      // A "correction" that is just the draft echoed back (often wrapped in
      // the fence markers) isn't a correction — deliver the draft untouched.
      const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
      if (normalize(corrected) === normalize(draftResponse)) return draftResponse;
      this.logger?.info({ guildId, channelId }, "Attribution verification corrected a misattributed reply");
      return corrected;
    } catch (error) {
      this.logger?.warn({ failure: safeFailure(error), guildId, channelId }, "Attribution verification failed; delivering the unverified draft");
      return draftResponse;
    }
  }

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
      emitChatDiagnostic(this.logger, { event: "chat.turn.started", interaction: input.interaction, ...(input.candidateId ? { candidateId: input.candidateId } : {}) });
      try {
        const plan: ConversationTurnPlan | null = this.characterRuntime ? this.characterRuntime.resolveTurnPlan(input.guildId, input.channelId) : {
          state: "ready", flow: "legacy", context: "guarded_text", decision: "legacy", deadlineMs: 30000, contextPolicy: { count: 40, budget: 12000 } };
        const failure = !plan ? "profile_unavailable" : plan.state === "blocked" ? plan.reason :
          !input.guardedContextPort ? "guard_unavailable" : null;
        emitChatDiagnostic(this.logger, { event: "chat.turn.plan", flow: plan?.flow ?? "legacy", context: plan?.context ?? "legacy",
          state: failure ? "blocked" : "ready", ...(failure ? { reason: failure } : {}) });
        if (failure || !plan || plan.state !== "ready") throw new SocialOutputSuppressed();
        const controller = new AbortController();
        timer = setTimeout(() => {
          emitChatDiagnostic(this.logger, { event: "chat.turn.deadline", budgetMs: plan.deadlineMs }); controller.abort();
        }, plan.deadlineMs);
        const planned: PlannedChatConversationInput = { ...input, turnPlan: plan,
          ...(plan.context === "guarded_text" ? { guardedContextPolicy: { ...plan.contextPolicy,
            ...(input.guardedContextPolicy?.minReactors === undefined ? {} : { minReactors: input.guardedContextPolicy.minReactors }) } } : {}) };
        const activeInput: PlannedChatConversationInput = { ...planned, turnSignal: controller.signal, turnDeadlineAt: Date.now() + plan.deadlineMs,
          canExecute: async (): Promise<boolean> => { assertTurnActive(controller.signal); const allowed = await withTurnAbort(controller.signal, () => input.canExecute?.() ?? Promise.resolve(true)); assertTurnActive(controller.signal); return allowed; },
          shouldDeliver: (): boolean => !controller.signal.aborted && (!input.shouldDeliver || input.shouldDeliver()) };
        const response = await withTurnAbort(controller?.signal, () => this.runScheduled(activeInput, async (result) => {
          assertTurnActive(controller?.signal);
          const text = await deliver(result);
          textDeliveryConfirmed = true;
          return text;
        }, observer));
        emitChatDiagnostic(this.logger, { event: "chat.turn.completed", interaction: input.interaction,
          outcome: textDeliveryConfirmed ? "text_delivered" : "no_text_delivery", textDeliveryConfirmed, durationMs: diagnosticElapsed(started) });
        return response;
      } catch (error) {
        emitChatDiagnostic(this.logger, { event: "chat.turn.completed", interaction: input.interaction,
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
    if (isExplicitInteraction(input.interaction)) this.cancelOptionalOpportunity(input.guildId, input.channelId, "addressed_request");
    const optional = !resolveConversationTrigger(input).explicit;
    const expiresAt = optional ? this.now() + 30_000 : null;
    const limits = { ...(input.resolveActivityLimits?.() ?? input.activityLimits ?? balancedChatLimits), continuation: input.interaction === "implicit_followup" };
    const silent: ChatResponse = {
      text: "", ambientAction: "ignore", reactionEmoji: null, historyReactions: [], userMemoryActions: [],
      guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false, generatedImages: [],
    };
    if (isOptionalInteraction(input.interaction) && !this.characterRuntime) {
      emitChatDiagnostic(this.logger, { event: "chat.turn.skipped", reason: "decision_unavailable" });
      return Promise.resolve(silent);
    }
    return this.scheduler.run(key, optional, limits, async () => {
      const forgetAtStart = new Map(this.forgottenBefore);
      const changedForgetCutoff = (id: string): number | undefined => {
        const subject = `${input.guildId}:${id}`; const cutoff = this.forgottenBefore.get(subject);
        return cutoff !== undefined && cutoff > (forgetAtStart.get(subject) ?? -Infinity) ? cutoff : undefined;
      };
      if (input.canExecute && !await input.canExecute()) {
        emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "execution_ineligible" });
        throw new SocialOutputSuppressed();
      }
      const runTurn = (turn: PlannedChatConversationInput, send: (response: ChatResponse) => Promise<string>, observe?: ChatResponseObserver): Promise<ChatResponse> => {
        if (!turn.guardedContextPort) throw new SocialOutputSuppressed();
        const guarded: GuardedChatConversationInput = { ...turn, guardedContextPort: turn.guardedContextPort };
        return new Promise<ChatResponse>((resolve, reject) => {
          let postTurn = Promise.resolve();
          // Hold this user's queue through post-turn writes, while resolving
          // their visible reply as soon as delivery/state commit succeeds.
          const work = this.queue.run(`${turn.guildId}:${turn.currentUser.id}`, async () => {
            try {
              const result = await withTurnAbort(turn.turnSignal, () => runGuardedChatTurn(guarded, { state: this.stateStore, runtime: this.characterRuntime,
                logger: this.logger, now: this.now, memory: this.memoryEngine, toolRegistry: this.toolRegistry,
                mutate: (operation) => this.runMemoryMutation(turn.guildId, turn.currentUser.id, operation),
                customization: this.userCustomizationStore, examples: this.exampleExchangeSelector, lore: this.personaLoreSelector,
                drift: this.personaDriftStore, postTurn: (dropped, extraction) => { postTurn = runGuardedPostTurn(guarded, dropped, {
                  extraction,
                    ...(this.characterRuntime ? { characterConfiguration: (id: string): Promise<string | null> => this.characterRuntime!.readCharacterConfiguration(guarded.guildId, guarded.channelId, id) } : {}),
                  provider: this.provider, utility: this.utilityProvider, memory: this.memoryEngine, customization: this.userCustomizationStore,
                  tools: this.toolRegistry, drift: this.personaDriftStore, logger: this.logger, now: this.now,
                  mutate: (operation) => this.runMemoryMutation(guarded.guildId, guarded.currentUser.id, operation),
                }).catch((error: unknown) => this.logger?.warn({ failure: safeFailure(error) }, "Guarded post-turn processing stopped")); },
                compact: (context) => this.conversationModels.compactReply(context),
                canCompact: this.conversationModels.canCompactReply,
                applicationToolsSupported: this.provider.applicationToolsSupported === true, nativeWebSearchSupported: this.provider.nativeWebSearchSupported === true, reply: (request, observer) => this.replyWithDiagnostics(request, observer),
                imageGenerationSupported: this.provider.imageGenerationSupported === true,
                repair: (text, request) => this.verifyAttribution(text, request), admitSocialPing: () => this.admitSocialPing(turn) }, send, observe));
              resolve(result);
              await postTurn;
            } catch (error) { reject(error instanceof Error ? error : new Error("Conversation execution failed", { cause: error })); }
          });
          this.trackBackground(work);
        });
      };
      const contextualAvailability = input.turnPlan.decision === "contextual" && isOptionalInteraction(input.interaction) ? {
        continuation: { text: this.scheduler.outputAvailable(key, "text", { ...limits, continuation: true }), reaction: input.historyReactionsEnabled === true && this.scheduler.outputAvailable(key, "reaction", limits) },
        spontaneous: { text: this.scheduler.outputAvailable(key, "text", { ...limits, continuation: false }), reaction: input.historyReactionsEnabled === true && this.scheduler.outputAvailable(key, "reaction", limits) },
      } : null;
      const response = await runTurn({ ...input,
        ...(contextualAvailability ? { contextualActionAvailability: contextualAvailability } : {}),
        ...(!isExplicitInteraction(input.interaction) ? { optionalActionsAvailable: {
          text: contextualAvailability ? contextualAvailability.continuation.text || contextualAvailability.spontaneous.text : this.scheduler.outputAvailable(key, "text", limits),
          reaction: input.historyReactionsEnabled === true && this.scheduler.outputAvailable(key, "reaction", limits),
        } } : {}),
        canExecute: async () => !input.canExecute || await input.canExecute(),
      }, async (result) => {
        const effects = authorizeConversationEffects(result, input.sourceMessageId ?? null);
        if (effects.action !== "reply" && effects.action !== "reply_and_react") throw new SocialOutputSuppressed();
        if (result.contextLease?.hasForgottenSource(changedForgetCutoff)) {
          emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "privacy_changed" });
          throw new SocialOutputSuppressed();
        }
        if (input.shadowMode) {
          emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "shadow" });
          await this.characterRuntime?.recordDelivery(input.guildId, input.sourceMessageId ?? null, false, true); return "";
        }
        if (input.shouldDeliver && !input.shouldDeliver()) {
          emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "delivery_cancelled" });
          throw new SocialOutputSuppressed();
        }
        const release = this.scheduler.reserveOutput(key, "text", { ...(input.resolveActivityLimits?.() ?? limits),
          continuation: result.conversationDecision?.decision.participationKind ? result.conversationDecision.decision.participationKind === "continuation" : input.interaction === "implicit_followup",
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
      if (effects.action !== "silent" && !input.shadowMode && !response.contextLease?.hasForgottenSource(changedForgetCutoff) &&
          (!input.shouldDeliver || input.shouldDeliver()) && (!input.canExecute || await input.canExecute()) && (!response.contextLease || await response.contextLease.validate("effect")) && (!response.characterCanDeliver || await response.characterCanDeliver())) await input.afterDecision?.(response);
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
      const response = await this.conversationModels.reply(request, purpose === "reply" ? observer : undefined);
      emitChatDiagnostic(this.logger, { event: "chat.model.completed", purpose, status: "valid", durationMs: diagnosticElapsed(started) });
      return response;
    } catch (error) {
      emitChatDiagnostic(this.logger, { event: "chat.model.completed", purpose, status: "failed", durationMs: diagnosticElapsed(started), ...safeFailure(error) });
      throw error;
    }
  }

}
