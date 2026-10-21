import { ConfigurationModelGateway } from "../context/configuration-model-gateway.js";
import { isEvaluationContext, type GuardedEvaluationContext } from "../context/guarded-evaluation-context.js";
import { isConfigurationContext, type GuardedConfigurationContext } from "../context/guarded-configuration-context.js";
import { GuardedConversationContext, isGuardedContext, projectDecisionContext, type GuardedContextPort } from "./guarded-conversation-context.js";
import { ConversationModelGateway } from "../context/conversation-model-gateway.js";
import { repairConversationRequest, requireApprovedConversationRequest } from "../context/approved-conversation-request.js";
import { approveModelOperation } from "../context/approved-model-operation.js";
import { approveDecisionInput } from "../context/approved-decision-input.js";
import { authorCharacterEdit, authoredCharacterResource } from "../context/authored-character-configuration.js";
import { isBackgroundContext, type GuardedBackgroundContext } from "../context/guarded-background-context.js";
import { selectDecisionContext } from "./decision-context-selection.js";
import { resolveConversationTurnPlan, type ConversationTurnPlan } from "./conversation-turn-plan.js";
import { contextualDecisionWireRevision } from "./contextual-decision-contract.js";
import type { ContextualDecisionProviders } from "./contextual-decision-providers.js";
import { z } from "zod";
import type { Logger } from "pino";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import { emitChatDiagnostic, safeFailure } from "../diagnostics/chat-diagnostics.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import type { ChatProvider, ChatRequest, ChatResponse, ChannelHistoryMessage, StructuredCharacterProvider, PersonalMemoryExtractionAction } from "./chat-provider.js";
import type { Memory, MemoryRepository } from "../memory/memory.js";
import { resolveChannelMemoryMode } from "../memory/memory-channel-policy.js";
import { characterSettings, characterInactiveReason, type CharacterModuleId, type CharacterCapabilities } from "./character-settings.js";
import { CharacterModuleRegistry, type CharacterTurn } from "./character-module-registry.js";
import { CharacterMemory, type CharacterCandidateQuery, type CharacterMemoryWrite } from "./character-memory.js";
import { addressedElsewhere, CharacterDecisionService, localAddressing, possiblePersonalFollowup, type CharacterDecision, type DecisionOutcome } from "./character-decision.js";
import { createCharacterModules } from "./character-modules/index.js";
import { hash, personaFingerprint, serious } from "./character-modules/shared.js";
import { resolveParticipation, contributionPolicy, passiveChannelAllowed } from "./participation-policy.js";
import { CharacterCallbacks, callbackState, callbackProofPayload } from "./character-callbacks.js";
import { startOfLocalDay } from "./character-calendar.js";
import type { CharacterEvaluationStore } from "./character-evaluation.js";
import { ConversationDecisionEngine, reportConversationDecision, type ConversationDecisionResult } from "./conversation-decision-engine.js";
import { resolveConversationTrigger } from "./conversation-trigger.js";
import { interviewProbes } from "./character-evaluation.js";
import type { PersonalMemoryExtractionQueueStore } from "../context/personal-memory-extraction-queue.js";

const textSchema: Record<string, unknown> = { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } };
export interface CharacterPreparedTurn { conversationDecision?: ConversationDecisionResult; turn: CharacterTurn; fingerprint: string; allowed: boolean; request: ChatRequest; targetMessageId: string | null; memoryContextSignature: string;
  decisionStatus: DecisionOutcome["status"] | "skipped"; acceptedContribution: CharacterDecision["contribution"] | null; exchangeId: string | null;
  participation: { action: "reply" | "ignore"; reaction: string | null } | null; styleUserId: string | null; styleSignature: string | null; targetConfidence: number }
export interface CharacterCallbackDelivery {
  context(guildId: string, channelId: string, sourceMessageId: string): Promise<GuardedContextPort | null>;
  run(guildId: string, channelId: string, operation: () => Promise<boolean>): Promise<boolean>;
  check(guildId: string, channelId: string, sourceMessageId: string): Promise<boolean>;
  send(guildId: string, channelId: string, sourceMessageId: string, text: string, replyToMessageId: string | null, context: GuardedConversationContext): Promise<string>;
}
export interface CharacterEvaluationAdmission {
  run<T>(guildId: string, channelId: string, operation: () => Promise<T>, cost: number): Promise<T | null>;
}

export class CharacterRuntime {
  private readonly registry: CharacterModuleRegistry;
  private readonly memory: CharacterMemory;
  private readonly callbacks: CharacterCallbacks;
  private readonly decisions: CharacterDecisionService;
  private readonly decisionEngine = new ConversationDecisionEngine();
  private readonly refreshes = new Map<string, number>();
  private readonly activity = new Map<string, { at: number; messageId: string; channelId: string }>();
  private readonly callbackCounts = new Map<string, { day: string; count: number }>();
  private callbackDelivery: CharacterCallbackDelivery | null = null;
  private callbackTimer: ReturnType<typeof setInterval> | null = null;
  private callbackRunning = false;
  private evaluationStore: CharacterEvaluationStore | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private probeRunning = false;
  private probeFactory: ((guildId: string, channelId: string, question: string) => Promise<GuardedEvaluationContext>) | null = null;
  private callbackPersona: ((guildId: string) => Promise<GuardedConfigurationContext>) | null = null;
  private stopped = false;
  private readonly pendingJobs = new Set<Promise<unknown>>();
  private readonly botIds = new Set<string>();
  private readonly privacyVersions = new Map<string, number>();
  private readonly seriousChannels = new Map<string, number>();
  private targetPreferences: ((guildId: string, userId: string) => Promise<{ customization: string | null }>) | null = null;
  private personaVersion: ((guildId: string) => Promise<string>) | null = null;
  private evaluationAdmission: CharacterEvaluationAdmission | null = null;
  public constructor(private readonly profiles: GuildConfigurationProvider, private readonly repository: MemoryRepository,
    private readonly utility: StructuredCharacterProvider | null, private readonly replyProvider: ChatProvider,
    decisionProvider: StructuredCharacterProvider | null = utility, private readonly coordinator: Pick<PersonalMemoryExtractionQueueStore, "runForSubject"> | null = null,
    private readonly now: () => number = () => Date.now(), private readonly logger: Pick<Logger, "info" | "warn"> | null = null,
    contextualProviders: ContextualDecisionProviders | null = null) {
    this.registry = new CharacterModuleRegistry((moduleId, error) => this.logger?.warn({ moduleId, ...safeFailure(error) }, "Character module hook failed"));
    this.memory = new CharacterMemory(repository, coordinator, (guildId) => this.profiles.find(guildId), (guildId, channelId, id) => {
      const profile = this.profiles.find(guildId); if (!profile) return false;
      return this.registry.has(id) && !(id === "canon" && characterSettings(profile).modules.canon.freeze) &&
        !characterInactiveReason(characterSettings(profile), id, channelId, this.capabilities(profile, channelId));
    }); this.callbacks = new CharacterCallbacks(repository); this.decisions = new CharacterDecisionService(decisionProvider, utility,
      (attempt) => emitChatDiagnostic(this.logger, { event: "model.decision.attempt", ...attempt }), contextualProviders);
    this.registerModules();
  }
  public capabilities(profile: GuildConfiguration, channelId: string): CharacterCapabilities {
    const participation = resolveParticipation(profile.chat.participation, channelId);
    return { decision: this.decisions.available, context: profile.features.channelHistory && characterSettings(profile).channelOverrides[channelId]?.contextEnabled !== false && resolveChannelMemoryMode(profile.chat.channelMemoryModes, channelId) !== "disabled",
      memorySharing: profile.chat.sharedMemoryEnabled === true, continuation: participation.continuationEnabled, spontaneous: participation.spontaneousEnabled,
      excluded: !profile.features.chatbot || resolveChannelMemoryMode(profile.chat.channelMemoryModes, channelId) === "disabled" };
  }
  public contextWindow(guildId: string, channelId: string): number | null {
    const profile = this.profiles.find(guildId);
    return profile && passiveChannelAllowed(profile, channelId) && characterSettings(profile).context.enabled && this.capabilities(profile, channelId).context ? characterSettings(profile).context.windowMinutes : null;
  }
  public contextAllowed(guildId: string, channelId: string): boolean {
    const profile = this.profiles.find(guildId); return !!profile && passiveChannelAllowed(profile, channelId) && this.capabilities(profile, channelId).context;
  }
  public get decisionAvailable(): boolean { return this.decisions.available; }
  public resolveTurnPlan(guildId: string, channelId: string): ConversationTurnPlan | null {
    const profile = this.profiles.find(guildId); return profile ? resolveConversationTurnPlan(profile, channelId) : null;
  }
  public get decisionHealth(): ReturnType<CharacterDecisionService["healthStatus"]> { return this.decisions.healthStatus(); }
  public checkDecisionHealth(): ReturnType<CharacterDecisionService["checkHealth"]> { return this.decisions.checkHealth(); }
  public couldBeAddressed(guildId: string, channelId: string, event: ChannelHistoryMessage, history: readonly ChannelHistoryMessage[], botId: string): boolean {
    const profile = this.profiles.find(guildId); if (!profile || !passiveChannelAllowed(profile, channelId)) return false;
    const settings = characterSettings(profile);
    const addressing = localAddressing(history, event, botId);
    return addressing === "bot" || addressing === "continuing" ||
      this.decisionAvailable && settings.context.enabled && settings.context.retrievalMode === "eligible_count" &&
      possiblePersonalFollowup(event.content) && !addressedElsewhere(event, history, botId);
  }
  private fingerprint(profile: GuildConfiguration, channelId: string): string {
    return hash(JSON.stringify([characterSettings(profile), this.capabilities(profile, channelId), profile.chat.channelMemoryModes, profile.chat.participation,
      profile.chat.webSearchMode, profile.chat.toolCallingEnabled, profile.chat.imageInputEnabled, profile.chat.imageGenerationEnabled, [...profile.channels.chatbot]]));
  }
  public stillEligible(prepared: CharacterPreparedTurn): boolean {
    if (this.stopped && (prepared.turn.settings.enabled || prepared.turn.settings.context.enabled)) return false;
    const profile = this.profiles.find(prepared.request.guildId);
    return !!profile && this.fingerprint(profile, prepared.request.channelId) === prepared.fingerprint;
  }
  public async validatePrepared(prepared: CharacterPreparedTurn): Promise<boolean> {
    // Conversational style and opportunity age are pinned for the turn.
    // The source lease and ingress policy own current privacy/access checks.
    if (isGuardedContext(prepared.request.contextLease)) return this.profiles.find(prepared.request.guildId)?.features.chatbot === true;
    const reject = (reason: "character_profile_changed" | "grounded_continuation_expired" | "persona_changed" | "target_preferences_changed" | "character_memory_changed"): false => {
      emitChatDiagnostic(this.logger, { event: "chat.guard.rejected", gate: "character", reason }); return false;
    };
    if (!this.stillEligible(prepared)) return reject("character_profile_changed");
    if (prepared.conversationDecision?.recovery === "grounded_reply" && !this.decisionEngine.canUseGroundedContinuation(prepared.request, this.now())) return reject("grounded_continuation_expired");
    if (this.personaVersion && prepared.request.characterPersonaHash && (prepared.turn.settings.enabled || prepared.turn.settings.context.enabled) &&
        await this.personaVersion(prepared.request.guildId) !== prepared.request.characterPersonaHash) return reject("persona_changed");
    if (prepared.styleUserId && prepared.styleSignature && this.targetPreferences &&
        JSON.stringify(await this.targetPreferences(prepared.request.guildId, prepared.styleUserId)) !== prepared.styleSignature) return reject("target_preferences_changed");
    // Solicited replies use a stable snapshot. Ordinary background learning
    // and mood expiry must not silence a mention. Explicit forgetting/access
    // changes still use conversation privacy versions and eligibility.
    if (isGuardedContext(prepared.request.contextLease) || prepared.request.triggerMode === "direct" || prepared.request.triggerMode === "ambient") return this.stillEligible(prepared);
    const current = await this.registry.contribute({ ...prepared.turn, validationNow: this.now() });
    return this.stillEligible(prepared) && JSON.stringify(current) === prepared.memoryContextSignature || reject("character_memory_changed");
  }
  private query(turn: CharacterTurn): CharacterCandidateQuery {
    return { guildId: turn.request.guildId, channelId: turn.request.channelId, userId: turn.request.currentUser.id, now: turn.validationNow ?? turn.now,
      ...(isGuardedContext(turn.request.contextLease) ? { sourceContext: turn.request.contextLease } : turn.backgroundContext ? { sourceContext: turn.backgroundContext } : {}) };
  }
  private profile(turn: CharacterTurn): GuildConfiguration { return this.profiles.require(turn.request.guildId); }
  private async generate(prompt: string, schema = textSchema, turn?: CharacterTurn): Promise<unknown> {
    if (!this.utility) return null;
    const guarded = isGuardedContext(turn?.request.contextLease);
    const check = async (): Promise<void> => {
      if (guarded) {
        await turn.request.beforeModelAttempt?.();
        if (!await turn.request.contextLease!.validate()) throw new SocialOutputSuppressed();
      } else if (turn?.backgroundContext) await turn.backgroundContext.check();
    };
    try {
      await check();
      const authority = guarded ? turn.request.contextLease! : turn?.backgroundContext;
      const result = await this.utility.generateCharacterData(prompt, schema, authority ? approveModelOperation(authority, "generateCharacterData", [prompt, schema], { beforeAttempt: check,
        ...(turn?.request.turnSignal ? { signal: turn.request.turnSignal } : {}) }) : undefined);
      await check(); return result;
    } catch (error) { if (error instanceof SocialOutputSuppressed) throw error; return null; }
  }
  private async text(prompt: string, turn?: CharacterTurn): Promise<string | null> {
    const output = z.object({ text: z.string().max(1000) }).safeParse(await this.generate(prompt, textSchema, turn));
    return output.success ? output.data.text.trim() || null : null;
  }
  private base(turn: CharacterTurn, slot: string, statement: string): CharacterMemoryWrite {
    return { kind: "fact", audience: "guild", ownerUserId: null, channelId: null, isolationChannelId: null,
      subjectType: "persona", subjectId: "character", topic: "character", slot, statement, status: "active", source: "consolidation", importance: 1,
      embedding: null, embeddingModel: null, expiresAt: null, now: turn.now, sourceMessageId: null,
      assertedByUserId: null, structuredValue: { personaHash: personaFingerprint(turn.request) }, sourceChannelId: null,
      ...(isGuardedContext(turn.request.contextLease) || turn.backgroundContext ? { sourceContext: turn.backgroundContext ?? turn.request.contextLease!, audience: "channel", channelId: turn.request.channelId,
        isolationChannelId: resolveChannelMemoryMode(this.profile(turn).chat.channelMemoryModes, turn.request.channelId) === "isolated" ? turn.request.channelId : null } : {}) };
  }
  private ready(turn: CharacterTurn, id: CharacterModuleId): boolean {
    const profile = this.profiles.find(turn.request.guildId);
    return !!profile && this.registry.has(id) && !(id === "canon" && characterSettings(profile).modules.canon.freeze) &&
      !characterInactiveReason(characterSettings(profile), id, turn.request.channelId, this.capabilities(profile, turn.request.channelId));
  }
  public bindEvaluationStore(store: CharacterEvaluationStore): void { this.evaluationStore = store; }
  public bindTargetPreferences(loader: (guildId: string, userId: string) => Promise<{ customization: string | null }>): void { this.targetPreferences = loader; }
  public bindPersonaVersion(loader: (guildId: string) => Promise<string>): void { this.personaVersion = loader; }
  public bindEvaluationAdmission(admit: CharacterEvaluationAdmission): void { this.evaluationAdmission = admit; }
  private trackJob(work: Promise<unknown>): void {
    this.pendingJobs.add(work);
    void work.catch(() => {}).finally(() => this.pendingJobs.delete(work));
  }
  public async drain(timeoutMs = 40_000): Promise<void> {
    if (!this.pendingJobs.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled([...this.pendingJobs]), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  public bindProbeSchedule(factory: (guildId: string, channelId: string, question: string) => Promise<GuardedEvaluationContext>): void {
    this.probeFactory = factory;
    this.probeTimer = setInterval(() => this.trackJob(this.tickProbes()), 60_000); this.probeTimer.unref?.();
  }
  public async tickProbes(now = this.now()): Promise<void> {
    if (this.stopped || this.probeRunning || !this.probeFactory || !this.evaluationStore || !this.registry.has("evaluation")) return;
    this.probeRunning = true;
    try {
      for (const profile of this.profiles.getAll()) {
        const controls = characterSettings(profile).modules.evaluation;
        const key = `probe:${profile.guildId}`;
        if (!controls.enabled || !controls.probes || now - (this.refreshes.get(key) ?? 0) < controls.intervalMinutes * 60_000) continue;
        this.refreshes.set(key, now);
        const question = interviewProbes[Math.floor(now / (controls.intervalMinutes * 60_000)) % interviewProbes.length]!;
        const channelId = [...profile.channels.chatbot][0] ?? "evaluation";
        const answer = await this.probe(await this.probeFactory(profile.guildId, channelId, question));
        const current = this.profiles.find(profile.guildId);
        if (!this.stopped && current && characterSettings(current).modules.evaluation.enabled && characterSettings(current).modules.evaluation.probes)
          await this.evaluationStore.record(profile.guildId, "probe", { scheduled: true, question, answer });
      }
    } finally { this.probeRunning = false; }
  }
  private registerModules(): void {
    for (const module of createCharacterModules({ memory: this.memory, repository: this.repository,
      profile: (turn) => this.profile(turn), query: (turn) => this.query(turn), base: (turn, slot, statement) => this.base(turn, slot, statement),
      ready: (turn, id) => this.ready(turn, id), generate: (prompt, schema, turn) => this.generate(prompt, schema, turn), text: (prompt, turn) => this.text(prompt, turn),
      repairVoice: (turn, draft) => {
        const notes = "Repair only casual voice/formatting: remove headings/lists, match examples, preserve factual content and complete substantive answers. Keep truthful bot disclosures.";
        return new ConversationModelGateway(this.replyProvider).reply(repairConversationRequest(turn.request, draft, notes));
      }, callbacks: this.callbacks, hasUtility: this.utility !== null })) this.registry.register(module);
  }
  public async prepare(request: ChatRequest): Promise<CharacterPreparedTurn | null> {
    requireApprovedConversationRequest(request);
    await request.beforeModelAttempt!();
    return this.prepareCore(request);
  }
  private async prepareCore(request: ChatRequest): Promise<CharacterPreparedTurn | null> {
    if (request.botUserId) this.botIds.add(request.botUserId);
    const profile = this.profiles.find(request.guildId); if (!profile) return null;
    const settings = characterSettings(profile); const capabilities = this.capabilities(profile, request.channelId);
    request = { ...request, characterGuardEnabled: settings.enabled && !capabilities.excluded };
    const fingerprint = this.fingerprint(profile, request.channelId);
    const privacyVersion = this.privacyVersions.get(request.guildId) ?? 0;
    const turn: CharacterTurn = { request, settings, capabilities, now: this.now() };
    const enabled = (id: CharacterModuleId): boolean => this.registry.has(id) && !characterInactiveReason(settings, id, request.channelId, capabilities);
    const guarded = isGuardedContext(request.contextLease);
    const guardedCharacterContext = guarded ? await this.registry.contribute(turn) : [];
    if (guardedCharacterContext.length) {
      request = { ...request, characterContext: [...(request.characterContext ?? []), ...guardedCharacterContext] }; turn.request = request;
    }
    const plan = request.turnPlan ?? resolveConversationTurnPlan(profile, request.channelId);
    if (!request.characterEvaluation && plan.state === "blocked") throw new SocialOutputSuppressed();
    const contextual = guarded && plan.state === "ready" && (plan.decision === "contextual" || request.currentEvent?.type === "reaction_snapshot");
    const events = guarded ? [...request.replyChain, ...request.channelHistory] : request.channelHistory;
    const burst = request.currentBurst?.length ? request.currentBurst : request.currentEvent?.type === "message" ? [{
      messageId: request.currentEvent.messageId, timestampMs: request.currentEvent.timestampMs, authorId: request.currentUser.id,
      authorDisplayName: request.currentUser.displayName, content: request.message, imageCount: request.images.length,
      replyToMessageId: request.currentEvent.replyToMessageId,
    }] : [];
    request = { ...request, currentBurst: burst }; turn.request = request;
    let decisionStatus: DecisionOutcome["status"] | "skipped" = this.decisions.available ? "skipped" : "unavailable";
    let acceptedContribution: CharacterDecision["contribution"] | null = null; let exchangeId: string | null = null;
    let textRejectionReason: string | null = null;
    const policy = contributionPolicy(profile.chat.participation);
    let allowed = true; let targetMessageId: string | null = null; let targetConfidence = 0;
    let participation: CharacterPreparedTurn["participation"] = null;
    let conversationDecision: ConversationDecisionResult | undefined;
    let styleUserId: string | null = null; let styleSignature: string | null = null;
    const optional = request.triggerMode === "continuation" || request.triggerMode === "spontaneous";
    const participationSettings = resolveParticipation(profile.chat.participation, request.channelId);
    if (optional && (!capabilities.context || !passiveChannelAllowed(profile, request.channelId) ||
        !(request.triggerMode === "continuation" ? participationSettings.continuationEnabled : participationSettings.spontaneousEnabled))) {
      const denied = this.decisionEngine.assess(request, { status: "skipped", decision: null }, profile.chat.participation, false, turn.now, fingerprint).result;
      reportConversationDecision(this.logger, denied, "preflight", resolveConversationTrigger(request).interaction);
      await this.evaluationStore?.record(request.guildId, "decision", { sourceMessageId: burst.at(-1)?.messageId ?? null, decisionStatus,
        proposedAction: "ignore", rejectionReason: !this.decisions.available ? "unavailable" : "scope_or_disabled", shadow: request.characterShadow ?? false });
      this.registry.reset(request.guildId);
      return { turn, request, fingerprint, allowed: false, decisionStatus, conversationDecision: denied, acceptedContribution: null, exchangeId: null,
        targetMessageId, memoryContextSignature: "[]", participation: { action: "ignore", reaction: null }, styleUserId, styleSignature, targetConfidence };
    }
    if (!request.characterEvaluation && (capabilities.context && (optional || settings.context.enabled || enabled("thoughts")) || request.triggerMode === "reaction")) {
      const contextualProjection = contextual ? selectDecisionContext(request, settings.context.decisionMessages) : null;
      const decisionEvents = contextualProjection?.events ?? (guarded ? projectDecisionContext(request, settings.context.decisionMessages) : events.slice(-settings.context.decisionMessages));
      if (contextualProjection) emitChatDiagnostic(this.logger, { event: "context.decision.coverage", ...contextualProjection.coverage });
      const fixedTarget = contextual && request.currentEvent?.type === "reaction_snapshot" ? request.currentEvent.targetMessageId : contextual && optional || request.triggerMode === "continuation" ? burst.at(-1)?.messageId ?? null : optional || request.triggerMode === "reaction" ? null : request.currentEvent?.type === "message" ? request.currentEvent.messageId : null;
      // Legacy reaction generation already selects its action in the reply
      // contract. Its bot target cannot enter the legacy human-target schema.
      const shouldDecide = optional || request.triggerMode === "reaction" && guarded;
      const decisionStarted = Date.now();
      const decisionInput = { personality: request.personality, events: decisionEvents, burst, botId: request.botUserId ?? "bot",
        ...(guarded ? { sourceContext: request.contextLease! } : {}),
        ...(guarded && (request.memories.length || request.guildKnowledge.length || request.causalChains.length || request.aliasCandidates?.length || guardedCharacterContext.length || request.personaLore.length || request.personaDrift || request.replyChainSummary) ? { supplementalFacts: [
          ...request.memories.map((record) => ({ subjectId: record.subjectUserId, statement: record.statement })),
          ...request.guildKnowledge.map((record) => ({ subjectId: record.subjectId, statement: record.statement })),
          ...request.personaLore.map((record) => ({ subjectId: "configured_persona_lore", statement: `Authored persona configuration: ${record.heading}\n${record.text}` })),
          ...(request.personaDrift ? [{ subjectId: "source_backed_persona_drift", statement: request.personaDrift }] : []),
          ...(request.replyChainSummary ? [{ subjectId: "source_backed_thread_summary", statement: request.replyChainSummary }] : []),
          ...guardedCharacterContext.map((record) => ({ subjectId: `character:${record.moduleId}`, statement: record.text })),
          ...request.causalChains.map((record) => ({ subjectId: record.fromSubjectId, statement: `Untrusted source-backed relation: ${JSON.stringify(record)}` })),
          ...(request.aliasCandidates ?? []).map((alias) => ({ subjectId: !alias.incomplete && alias.subjectIds.length === 1 ? alias.subjectIds[0]! : "ambiguous_alias",
            statement: `Untrusted observed label; multiple IDs or incomplete=true require clarification, never guess: ${JSON.stringify(alias)}` })),
        ] } : {}),
        fixedTarget, contextual, useContextBoundary: !guarded && settings.context.retrievalMode !== "eligible_count", gapMs: settings.context.segmentGapMinutes * 60_000,
        ...(contextual && request.currentEvent?.type === "reaction_snapshot" ? { reactionSnapshot: request.currentEvent } : {}),
        ...(request.turnSignal ? { signal: request.turnSignal } : {}), ...(request.turnDeadlineAt ? { deadlineAt: request.turnDeadlineAt } : {}),
        speakingShare: decisionEvents.length ? decisionEvents.filter((event) => event.authorId === request.botUserId).length / decisionEvents.length : 0,
        canUseContext: guarded ? (): Promise<boolean> => request.contextLease!.validate() : undefined, thoughts: !guarded && optional && enabled("thoughts"), availableActions: request.optionalActionsAvailable, now: turn.now };
      const outcome = shouldDecide ? await this.decisions.evaluate(guarded ? approveDecisionInput(decisionInput) : decisionInput) : { status: "skipped" as const, decision: null };
      const decision = outcome.decision; decisionStatus = outcome.status;
      const liveProfile = this.profiles.find(request.guildId);
      if (!liveProfile || !liveProfile.features.chatbot || !guarded && (this.fingerprint(liveProfile, request.channelId) !== fingerprint || (this.privacyVersions.get(request.guildId) ?? 0) !== privacyVersion)) {
        this.registry.reset(request.guildId);
        emitChatDiagnostic(this.logger, { event: "chat.output.suppressed", reason: "privacy_changed" });
        throw new SocialOutputSuppressed();
      }
      if (decision?.contextual) emitChatDiagnostic(this.logger, { event: "chat.decision.proposed", wireRevision: contextualDecisionWireRevision,
        relationship: decision.contextual.relationship, referent: decision.contextual.referent, intent: decision.contextual.intent,
        action: decision.contextual.action, evidenceCount: decision.recipientEvidence.length, linkKind: decision.contextual.link?.kind ?? null,
        recipientConfidence: decision.recipientConfidence, confidence: decision.confidence });
      const assessment = this.decisionEngine.assess({ ...request, currentBurst: burst }, outcome, profile.chat.participation, true, turn.now, fingerprint);
      if (optional || request.triggerMode === "reaction") reportConversationDecision(this.logger, assessment.result, "preflight", resolveConversationTrigger(request).interaction);
      const local = assessment.local;
      if (optional || request.triggerMode === "reaction") {
        conversationDecision = assessment.result;
        const action = conversationDecision.decision.action;
        allowed = action !== "silent";
        participation = { action: action === "reply" || action === "reply_and_react" ? "reply" : "ignore", reaction: assessment.reaction };
        acceptedContribution = assessment.contribution;
        exchangeId = assessment.exchangeId;
        targetMessageId = assessment.targetMessageId;
        targetConfidence = assessment.targetConfidence;
        textRejectionReason = participation.action === "reply" ? null : conversationDecision.decision.reasonCode;
      }
      if (!guarded && settings.context.retrievalMode !== "eligible_count" && decision && settings.context.enabled && !settings.context.shadow && decision.boundary !== "earlier") {
        const index = events.findIndex((event) => event.messageId === decision.boundary);
        if (index >= 0) request = { ...request, channelHistory: events.slice(Math.min(index, Math.max(0, events.length - 8))) };
      }
      turn.request = request;
      if (!guarded) request = this.registry.applyDecision(turn, { decision, events, burst, optional, local, policy });
      if (optional) {
        const action = !allowed ? "ignore" : participation?.action === "reply" ? "reply" : participation?.reaction ? "reaction" : "ignore";
        const rejectionReason = action === "ignore" ? textRejectionReason ?? "no_action" : null;
        await this.evaluationStore?.record(request.guildId, "decision", {
          sourceMessageId: burst.at(-1)?.messageId ?? null, decisionStatus, proposedAction: action, rejectionReason,
          recipient: local, target: decision?.target ?? null, recipientEvidence: decision?.recipientEvidence ?? [],
          confidence: decision?.confidence ?? null, contributionLabel: decision?.contribution.label ?? null,
          latencyMs: Date.now() - decisionStarted, shadow: request.characterShadow ?? false,
        });
        this.logger?.info({ guildId: request.guildId, channelId: request.channelId, sourceMessageId: burst.at(-1)?.messageId ?? null,
          triggerMode: request.triggerMode, decisionStatus, action, rejectionReason, textRejectionReason,
          textAvailable: request.optionalActionsAvailable?.text ?? null, reactionAvailable: request.optionalActionsAvailable?.reaction ?? null,
          recipientConfidence: decision?.recipientConfidence ?? null, targetConfidence: decision?.targetConfidence ?? null,
          decisionConfidence: decision?.confidence ?? null, contributionMotivation: decision?.contribution.motivation ?? null,
          recovery: conversationDecision?.recovery, recipient: local }, "Optional participation decision");
      }

    }
    turn.request = request;
    if (!request.characterEvaluation && !request.characterShadow && burst.at(-1)) await this.registry.observe(burst.at(-1)!, turn);
    const context = guarded ? guardedCharacterContext : await this.registry.contribute(turn);
    if (!guarded) request = { ...request, characterContext: [...(request.characterContext ?? []), ...context] };
    if (targetMessageId) {
      const target = [...events, ...burst].find((event) => event.messageId === targetMessageId);
      if (target) {
        const preferences = !guarded && target.authorId !== request.currentUser.id ? await this.targetPreferences?.(request.guildId, target.authorId) : null;
        if (preferences) { styleUserId = target.authorId; styleSignature = JSON.stringify(preferences); }
        if (target.authorId !== request.currentUser.id) request = { ...request, userCustomization: null, birthday: null };
        request.characterContext = [...(request.characterContext ?? []), { moduleId: "conversation-context", text:
          `The chosen reply target is ${JSON.stringify(target)}. The trigger's author is ${request.currentUser.id}; do not transfer their facts or preferences to the target's author. Treat other messages as surrounding context. Target style preferences (untrusted, only for this target): ${JSON.stringify(preferences)}` }];
      }
      else targetMessageId = null;
    }
    const requestedAnswer = conversationDecision?.decision.participationKind === "continuation" && conversationDecision.decision.action === "reply" &&
      (conversationDecision.decision.intent === "answer" || conversationDecision.decision.intent === "clarify");
    if (requestedAnswer) request = { ...request, characterContext: [...(request.characterContext ?? []), { moduleId: "participation",
      text: "Answer or clarify the current speaker's grounded follow-up using the supplied authorized conversation. A brief requested confirmation can be a complete answer; it does not need to add an unsolicited contribution. Use ambientAction reply and responseIntent answer or clarify. Do not claim a repair or operational status you cannot verify." }] };
    else if (acceptedContribution) request = { ...request, characterContext: [...(request.characterContext ?? []), { moduleId: "participation",
      text: `Serve only this accepted contribution; do not merely acknowledge, repeat or introduce unrelated help. Do not strengthen its factual claims. Untrusted candidate: ${JSON.stringify(acceptedContribution)}` }] };
    else if (!optional) request = { ...request, characterContext: [...(request.characterContext ?? []), { moduleId: "participation", text: "Answer explicit questions and tool requests normally. Keep acknowledgments brief; do not prolong a closing with another question or generic help." }] };
    turn.request = request;
    return { turn, request, fingerprint, allowed, decisionStatus, acceptedContribution, exchangeId, targetMessageId, memoryContextSignature: JSON.stringify(context), participation, styleUserId, styleSignature, targetConfidence, ...(conversationDecision ? { conversationDecision } : {}) };
  }
  public async process(reply: ChatResponse, prepared: CharacterPreparedTurn): Promise<ChatResponse> {
    requireApprovedConversationRequest(prepared.request);
    if (prepared.turn.request !== prepared.request) throw new SocialOutputSuppressed();
    await prepared.request.beforeModelAttempt!();
    return this.processCore(reply, prepared);
  }
  private async processCore(reply: ChatResponse, prepared: CharacterPreparedTurn): Promise<ChatResponse> {
    const processed = await this.registry.postProcess(reply, prepared.turn);
    return { ...processed, ...(prepared.exchangeId ? { participationExchangeId: prepared.exchangeId } : {}), characterIsCurrent: () => isGuardedContext(prepared.request.contextLease) ?
      this.profiles.find(prepared.request.guildId)?.features.chatbot === true : this.stillEligible(prepared),
      characterCanDeliver: () => this.validatePrepared(prepared),
      ...(prepared.targetMessageId ? { replyTargetMessageId: prepared.targetMessageId,
        inferredAddressing: { label: "inferred" as const, confidence: prepared.targetConfidence, messageId: prepared.targetMessageId } } : {}) };
  }
  public learnGuarded(reply: ChatResponse, prepared: CharacterPreparedTurn): Promise<readonly PersonalMemoryExtractionAction[] | null> {
    requireApprovedConversationRequest(prepared.request);
    if (prepared.turn.request !== prepared.request) throw new SocialOutputSuppressed();
    if (!isGuardedContext(prepared.request.contextLease)) throw new SocialOutputSuppressed();
    const work = (async (): Promise<readonly PersonalMemoryExtractionAction[] | null> => {
      if (!this.stillEligible(prepared) || !await prepared.request.contextLease!.validate()) return null;
      await this.registry.consolidate(reply, prepared.turn);
      if (!await prepared.request.contextLease!.validate()) return null;
      return this.registry.extractMemories(prepared.request.message, reply, prepared.turn);
    })();
    this.trackJob(work); return work;
  }
  public async afterMemoryConsolidation(context: GuardedBackgroundContext, subjectIds: readonly string[]): Promise<void> {
    if (!isBackgroundContext(context, "summary") && !isBackgroundContext(context, "memory_extraction")) throw new SocialOutputSuppressed();
    await context.check(); const { guildId, channelId } = context.messages[0]!;
    const profile = this.profiles.find(guildId); if (!profile || this.stopped || characterInactiveReason(characterSettings(profile), "relationships", channelId, this.capabilities(profile, channelId))) return;
    for (const userId of [...new Set(subjectIds)].slice(0, 5)) {
      if (!context.messages.some((message) => message.authorId === userId)) continue;
      await context.check();
      // Closed relationship lifecycle input, never a model request. No raw
      // persona, participant memories or synthetic evaluation text is loaded.
      const request: ChatRequest = { guildId, channelId, personality: "", personaLore: [], personaDrift: null, exampleExchanges: [], userCustomization: null,
        currentUser: { id: userId, displayName: "", roleNames: [] }, mentionedUsers: [], recentHistory: [], memories: [], guildKnowledge: [], causalChains: [],
        message: "", replyChain: [], replyChainSummary: null, channelHistory: [], birthday: null, images: [], webSearchMode: "off",
        imageGenerationEnabled: false, includeSources: false, triggerMode: "direct" };
      await this.registry.consolidateModule("relationships", { text: "", userMemoryActions: [], guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false, generatedImages: [], ambientAction: "ignore", reactionEmoji: null, historyReactions: [] },
        { request, backgroundContext: context, settings: characterSettings(this.profiles.require(guildId)), capabilities: this.capabilities(profile, channelId), now: this.now() });
    }
  }
  public async probe(context: GuardedEvaluationContext): Promise<string> {
    if (!isEvaluationContext(context)) throw new SocialOutputSuppressed(); await context.check();
    const run = (): Promise<string> => new ConfigurationModelGateway(this.replyProvider).probe(context, true, () => !this.stopped);
    return (await (this.evaluationAdmission ? this.evaluationAdmission.run(context.scope.guildId, context.scope.channelId, run, 1) : run())) ?? "Evaluation postponed: cooldown or optional-call budget.";
  }
  public async probeMany(contexts: readonly GuardedEvaluationContext[]): Promise<readonly { question: string; answer: string }[]> {
    const first = contexts[0]; if (!first) return [];
    if (contexts.length > 16 || !isEvaluationContext(first)) throw new SocialOutputSuppressed();
    for (const context of contexts) {
      if (!isEvaluationContext(context) || JSON.stringify(context.scope) !== JSON.stringify(first.scope)) throw new SocialOutputSuppressed();
      await context.check();
    }
    const run = async (): Promise<{ question: string; answer: string }[]> => {
      const outputs: { question: string; answer: string }[] = [];
      const gateway = new ConfigurationModelGateway(this.replyProvider);
      for (const context of contexts) outputs.push({ question: context.question, answer: await gateway.probe(context, true, () => !this.stopped) });
      return outputs;
    };
    return (await (this.evaluationAdmission ? this.evaluationAdmission.run(first.scope.guildId, first.scope.channelId, run, contexts.length) : run())) ??
      contexts.map((context) => ({ question: context.question, answer: "Evaluation postponed: cooldown or optional-call budget." }));
  }
  public async probePair(context: GuardedEvaluationContext): Promise<{ A: string; B: string; candidate: "A" | "B" }> {
    if (!isEvaluationContext(context)) throw new SocialOutputSuppressed(); await context.check();
    const run = async (): Promise<{ A: string; B: string; candidate: "A" | "B" }> => {
      const gateway = new ConfigurationModelGateway(this.replyProvider);
      const baseline = await gateway.probe(context, false, () => !this.stopped);
      const candidate = await gateway.probe(context, true, () => !this.stopped); const first = Math.random() < 0.5;
      return { A: first ? candidate : baseline, B: first ? baseline : candidate, candidate: first ? "A" : "B" };
    };
    return (await (this.evaluationAdmission ? this.evaluationAdmission.run(context.scope.guildId, context.scope.channelId, run, 2) : run())) ??
      { A: "Evaluation postponed: cooldown or optional-call budget.", B: "Evaluation postponed: cooldown or optional-call budget.", candidate: "A" };
  }
  public bindCallbackPersona(factory: (guildId: string) => Promise<GuardedConfigurationContext>): void { this.callbackPersona = factory; }
  public describeStatus(profile: GuildConfiguration, channelId: string): string {
    const settings = characterSettings(profile); const capabilities = this.capabilities(profile, channelId);
    const labels = { master_disabled: "character master switch is off", module_disabled: "module is off", excluded: "chat disabled or memory excluded",
      needs_context: "needs conversation context", needs_decision: "needs a decision/utility provider", needs_memorySharing: "needs memory sharing",
      needs_continuation: "needs continuation", needs_participation: "needs continuation or spontaneous participation", needs_addressing: "needs implicit addressing", needs_canon: "needs canon" };
    return [...this.registry.active({ request: { guildId: profile.guildId, channelId } as ChatRequest, settings, capabilities, now: this.now() }).map((module) => `${module.id}: enabled`),
      ...Object.keys(settings.modules).filter((id) => id !== "addressing").flatMap((id) => {
        const reason = characterInactiveReason(settings, id as CharacterModuleId, channelId, capabilities);
        return !this.registry.has(id as CharacterModuleId) ? [`${id}: module unavailable`] : reason ? [`${id}: ${labels[reason as keyof typeof labels] ?? reason}`] : [];
      })].join("\n");
  }
  public async manageCanon(guildId: string, userId: string, channelId: string, operation: string, id: string | null, statement: string | null, moduleId: "canon" | "mood" | "daily-sketch" = "canon"): Promise<string> {
    const edit = (): Promise<string> => this.manageCanonChecked(guildId, userId, channelId, operation, id, statement, moduleId);
    return this.coordinator ? this.coordinator.runForSubject(guildId, "character", edit) : edit();
  }
  private async manageCanonChecked(guildId: string, userId: string, channelId: string, operation: string, id: string | null, statement: string | null, moduleId: "canon" | "mood" | "daily-sketch"): Promise<string> {
    if (operation === "clear") {
      await this.repository.recordForgetCutoff({ guildId, subjectId: "character", topic: `character.${moduleId}`, slot: "*", scopeKey: "*", cutoff: this.now() });
      return `Cleared ${await this.repository.clearModuleData?.(guildId, moduleId) ?? 0} ${moduleId} records.`;
    }
    const rows = await this.repository.findModuleCandidates?.({ guildId, channelId, userId, moduleId, now: this.now() });
    if (operation === "list") return rows?.memories.map((row) => `${row.id}: ${row.statement}`).join("\n") || `No ${moduleId} entries.`;
    const memory = rows?.memories.find((row) => row.id === id);
    if (!memory) return `${moduleId} entry not found.`;
    if (operation === "delete") {
      await this.repository.recordForgetCutoff({ guildId, subjectId: "character", topic: memory.topic, slot: memory.slot, scopeKey: memory.isolationChannelId ?? memory.channelId ?? "*", cutoff: this.now() });
      await this.repository.forget({ guildId, memoryId: memory.id }); return `${moduleId} entry deleted.`;
    }
    if (operation !== "edit") return "Unknown ledger operation.";
    if (!statement?.trim() || statement.length > 200) return "Statements must contain 1–200 characters.";
    const persona = await this.callbackPersona?.(guildId);
    if (!isConfigurationContext(persona, "persona")) return "Character configuration authority is unavailable.";
    await persona.check({ kind: "persona", guildId, ownerUserId: null });
    const replacement = authorCharacterEdit(memory, channelId, userId, statement, this.now(), persona);
    if (!replacement) return "This entry cannot be edited in that channel. Choose its original channel and an active character entry.";
    await this.repository.ingest(replacement);
    await persona.check({ kind: "persona", guildId, ownerUserId: null });
    return `${moduleId} entry updated.`;
  }

  public readCharacterConfiguration(guildId: string, channelId: string, id: string): Promise<string | null> {
    const profile = this.profiles.find(guildId);
    if (!profile || !this.capabilities(profile, channelId).context) return Promise.resolve(null);
    return authoredCharacterResource(this.repository, guildId, channelId, id, this.now());
  }

  public recordDelivery(guildId: string, sourceMessageId: string | null, delivered: boolean, shadow: boolean): Promise<void> {
    return this.evaluationStore?.record(guildId, "delivery", { sourceMessageId, delivered, shadow }).then(() => undefined).catch(() => undefined) ?? Promise.resolve();
  }
  public observe(guildId: string, channelId: string, event: ChannelHistoryMessage): void {
    const profile = this.profiles.find(guildId); if (!profile || !passiveChannelAllowed(profile, channelId) || this.stopped || event.author?.kind === "bot" || this.botIds.has(event.authorId)) return;
    if (serious(event.content)) { if (this.seriousChannels.size >= 256) this.seriousChannels.delete(this.seriousChannels.keys().next().value!); this.seriousChannels.set(`${guildId}:${channelId}`, this.now() + 10 * 60_000); }
    if (this.activity.size >= 1000) this.activity.delete(this.activity.keys().next().value!);
    this.activity.set(`${guildId}:${event.authorId}`, { at: event.timestampMs, messageId: event.messageId, channelId });
  }
  public excludeContext(guildId: string, messageId: string): void {
    this.privacyVersions.set(guildId, (this.privacyVersions.get(guildId) ?? 0) + 1); this.registry.reset(guildId);
    this.trackJob(this.evaluationStore?.excludeSource(guildId, messageId) ?? Promise.resolve());
  }
  public forget(guildId: string, userId: string): void {
    this.privacyVersions.set(guildId, (this.privacyVersions.get(guildId) ?? 0) + 1);
    this.trackJob(this.evaluationStore?.forget(guildId) ?? Promise.resolve());
    this.activity.delete(`${guildId}:${userId}`);
    this.registry.reset(guildId);
  }
  public bindCallbackDelivery(delivery: CharacterCallbackDelivery): void {
    this.callbackDelivery = delivery;
    this.callbackTimer = setInterval(() => this.trackJob(this.tickCallbacks()), 60_000); this.callbackTimer.unref?.();
  }
  public stop(): void { if (this.callbackTimer) clearInterval(this.callbackTimer); if (this.probeTimer) clearInterval(this.probeTimer);
    this.stopped = true; this.probeTimer = null; this.callbackTimer = null; this.registry.reset(); }
  public async tickCallbacks(now = this.now()): Promise<void> {
    if (this.stopped || this.callbackRunning || !this.callbackDelivery) return;
    this.callbackRunning = true;
    try {
      for (const profile of this.profiles.getAll()) await this.repository.deleteExpiredModuleData?.(profile.guildId, now, characterSettings(profile).modules.canon.retentionDays);
      for (const [key, activity] of this.activity) {
        if (now - activity.at > 15 * 60_000) continue;
        const separator = key.indexOf(":"); const guildId = key.slice(0, separator); const userId = key.slice(separator + 1);
        const profile = this.profiles.find(guildId); if (!profile) continue;
        if ((this.seriousChannels.get(`${guildId}:${activity.channelId}`) ?? 0) > now) continue;
        const settings = characterSettings(profile);
        if (!this.registry.has("callbacks") || characterInactiveReason(settings, "callbacks", activity.channelId, this.capabilities(profile, activity.channelId))) continue;
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: profile.timezone }).format(new Date(now));
        const count = this.callbackCounts.get(guildId); if (count?.day === day && count.count >= settings.modules.callbacks.maxPerDay) continue;
        const query = { guildId, channelId: activity.channelId, userId, now };
        const due = await this.repository.findDueCallbackCandidates?.({ ...query, subjectIds: [userId] });
        const memories = (due?.memories ?? []).filter((memory) => callbackState(memory)?.deliveryChannelId === activity.channelId);
        for (const memory of memories) {
          const schedule = callbackState(memory); if (!schedule?.contextProvenance) continue;
          const port = await this.callbackDelivery.context(guildId, activity.channelId, activity.messageId);
          if (!port || port.guildId !== guildId || port.channelId !== activity.channelId || port.actorId !== userId) continue;
          const context = await GuardedConversationContext.open(port, { count: 0, budget: 0, burstIds: [] }).catch(() => null);
          if (!context || !(await context.memories([memory], true, now)).length ||
              !await context.derived(schedule.contextProvenance, callbackProofPayload(memory, schedule), "character_state")) continue;
          const schedulePayload = callbackProofPayload(memory, schedule);
          const claim = await this.callbacks.claim(memory, now, settings.modules.callbacks.maxPerDay, startOfLocalDay(now, profile.timezone)); if (!claim) continue;
          const eligible = async (fact: Memory): Promise<boolean> => {
            const live = this.profiles.find(guildId);
            const current = await this.repository.findById(guildId, fact.id);
            const state = current && callbackState(current); const expected = callbackState(fact);
            if (!current || current.status !== "active" || current.updatedAt !== fact.updatedAt || !state || !expected ||
                state.attemptId !== expected.attemptId || !["claimed", "sending"].includes(state.status) ||
                (state.leaseUntil ?? 0) <= this.now() || state.expiresAt <= this.now()) return false;
            if (callbackProofPayload(current, state) !== schedulePayload || JSON.stringify(state.contextProvenance) !== JSON.stringify(schedule.contextProvenance)) return false;
            const sourceIds = new Set((await this.repository.findSources(current.id)).map((source) => source.id));
            if (!state.sourceIds.length || state.sourceIds.some((id) => !sourceIds.has(id))) return false;
            return !this.stopped && !!live && (this.seriousChannels.get(`${guildId}:${activity.channelId}`) ?? 0) <= this.now() &&
              !characterInactiveReason(characterSettings(live), "callbacks", activity.channelId, this.capabilities(live, activity.channelId)) &&
              this.now() - (this.activity.get(key)?.at ?? 0) < 15 * 60_000 && await context.validate() && await this.memory.sourceEligible(current, live, { ...query, now: this.now(), sourceContext: context }) &&
              await this.callbackDelivery!.check(guildId, activity.channelId, activity.messageId);
          };
          const sent = await this.callbackDelivery.run(guildId, activity.channelId, async () => {
            const persona = await this.callbackPersona?.(guildId);
            if (!isConfigurationContext(persona, "persona") || persona.scope.guildId !== guildId) { await this.callbacks.failBeforeSend(claim, this.now()); return false; }
            const beforeModelAttempt = async (): Promise<void> => {
              await persona.check({ kind: "persona", guildId, ownerUserId: null });
              if (!await eligible(claim) || await context.resource({ kind: "persona_configuration", id: "current" }) !== persona.fingerprint) throw new SocialOutputSuppressed();
            };
            await beforeModelAttempt();
            const turn: CharacterTurn = { request: { guildId, channelId: activity.channelId, personality: persona.material.text,
              configurationContext: persona, contextLease: context, beforeModelAttempt,
              personaLore: (persona.material.loreChunks ?? []).map(({ heading, text }) => ({ heading, text })), exampleExchanges: [], personaDrift: null,
              userCustomization: null, currentUser: { id: userId, displayName: "", roleNames: [] }, mentionedUsers: [], recentHistory: [], memories: [],
              guildKnowledge: [], causalChains: [], message: "", replyChain: [], replyChainSummary: null, channelHistory: [], birthday: null, images: [],
              webSearchMode: "off", imageGenerationEnabled: false, includeSources: false, triggerMode: "direct" }, settings,
              capabilities: this.capabilities(profile, activity.channelId), now };
            const text = await this.text(`Write one short welcome follow-up after this member's dated event. Ask how it went, don't assert it happened. Match persona, no invented shared past or real-world action. Data: ${JSON.stringify({ event: memory.statement, memberId: userId, character: profile.displayName,
              personality: persona.material.text, lore: (persona.material.loreChunks ?? []).map(({ heading, text }) => ({ heading, text })) }).replaceAll("<", "\\u003c")}`, turn);
            if (!text) { await this.callbacks.failBeforeSend(claim, this.now()); return false; }
            return this.callbacks.send(claim, this.now(), eligible, async (sending) => {
              if (!await eligible(sending)) throw new Error("Callback final eligibility failed");
              return this.callbackDelivery!.send(guildId, activity.channelId, activity.messageId, text, callbackState(sending)?.eventMessageId ?? null, context);
            });
          }).catch(async () => { await this.callbacks.failBeforeSend(claim, this.now()); return false; });
          if (sent) this.callbackCounts.set(guildId, { day, count: count?.day === day ? count.count + 1 : 1 });
          break;
        }
      }
    } finally { this.callbackRunning = false; }
  }
}
