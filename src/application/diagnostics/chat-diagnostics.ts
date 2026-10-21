import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Logger } from "pino";
import { z } from "zod";
import type { ChatTraceStore } from "./chat-trace-store.js";

export const diagnosticProcessRunId = randomUUID();
let traceSequence = 0;
let eventSequence = 0;
const diagnosticStoreKey = Symbol("chatDiagnosticStore");
const pipelineKey = Symbol("chatDiagnosticPipeline");
export interface DiagnosticPipelineStatus { attempted: number; invalidEvents: number; unscopedEvents: number; retentionFailures: number; logFailures: number }
const pipelineStatuses = new WeakMap<DiagnosticLogger, DiagnosticPipelineStatus>();
function pipelineStatus(logger: DiagnosticLogger): DiagnosticPipelineStatus {
  const root = (logger as DiagnosticLogger & { [pipelineKey]?: DiagnosticLogger })[pipelineKey] ?? logger;
  let status = pipelineStatuses.get(root);
  if (!status) { status = { attempted: 0, invalidEvents: 0, unscopedEvents: 0, retentionFailures: 0, logFailures: 0 }; pipelineStatuses.set(root, status); }
  return status;
}
export function diagnosticPipelineStatus(logger: DiagnosticLogger): Readonly<DiagnosticPipelineStatus> { return { ...pipelineStatus(logger) }; }

const count = z.number().int().nonnegative();
const duration = z.number().finite().nonnegative();
const identifier = z.string().min(1).max(128).regex(/^[\w.:-]+$/u);
const trigger = z.enum(["direct", "ambient", "continuation", "spontaneous", "reaction"]);
export const decisionValidationFields: readonly string[] = ["root", "item", "addressing", "motivation", "recipientEvidence", "recipientConfidence", "targetConfidence", "contribution", "opening", "boundary", "target", "confidence", "reaction", "thoughts", "text", "adds", "label", "sourceMessageId", "recipientId", "relationship", "intent", "action", "targetKey", "referent", "linkKey"];
export const eligibilityReason = z.enum(["not_guild", "chat_disabled", "needs_conversation_context", "background_scope_denied", "passive_scope_denied", "passive_access_denied", "game_channel", "continuation_disabled", "spontaneous_disabled", "history_reactions_disabled", "ambient_disabled", "reaction_disabled", "utility_or_unknown_bot_output", "channel_denied", "access_denied", "utility_interaction", "cyclic_reply_chain", "unknown_bot_output", "utility_reply", "cross_channel_reply", "unresolved_reply_origin", "reply_depth_limit", "unverifiable_bot_context", "origin_lookup_failed", "source_forgotten", "forget_policy_unavailable"]);

export const failureCategory = z.enum([
  "timeout", "http_error", "rate_limited", "invalid_json", "schema_mismatch",
  "incomplete_response", "transport_error", "provider_error", "provider_cooldown", "operation_error", "invalid_target",
  "fixed_target_mismatch", "invalid_boundary", "invalid_evidence", "invalid_contribution",
  "invalid_thought", "recipient_mismatch",
]);
export type FailureCategory = z.infer<typeof failureCategory>;

// Allow-list every serialized field. Runtime stripping also protects callers
// compiled without TypeScript, and prevents raw provider/Discord objects leaking.
const eventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("context.guard.work"), phase: z.enum(["assembly", "sessions", "memory", "assets", "relations", "identities", "validation"]), status: z.enum(["completed", "deadline", "failed"]), durationMs: duration }),
  z.object({ event: z.literal("chat.access.refreshed"), cachedReason: z.enum(["member_unavailable", "restricted_role", "channel_denied", "missing_chat_role"]), currentReason: z.enum(["allowed", "member_unavailable", "restricted_role", "channel_denied", "missing_chat_role"]) }),
  z.object({ event: z.literal("chat.delivery.bookkeeping_failed"), stage: z.enum(["proof", "origin"]), failure: failureCategory, httpStatus: z.number().int().min(100).max(599).optional() }),
  z.object({ event: z.literal("context.guard.validation"), status: z.enum(["current", "changed", "deadline", "bounded"]), reads: count }),
  z.object({ event: z.literal("context.guard.coverage"), replyChain: count, replyOverflow: count.optional(), replyBounded: z.boolean(), burst: count, eligibleReactors: count, omittedReactors: count, requested: count, fetched: count, examined: count, duplicates: count, unverifiedBot: count, invalidatedDerived: count,
    selectedIds: z.array(identifier).max(128), oldestTimestampMs: duration.nullable(), newestTimestampMs: duration.nullable(), eligible: count, selected: count, pages: count, targetedPages: count,
    omitted: count, truncated: count, sourceReads: count, status: z.enum(["filled", "end", "scan_cap", "deadline", "fetch_failed", "source_ineligible", "ineligible_reaction", "no_progress"]) }),
  z.object({ event: z.literal("context.guard.sources"), sessions: count, memories: count.optional(), relations: count.optional(), actors: count.optional(), images: count.optional(), configurations: count.optional(), unavailable: z.array(z.enum(["legacy_derived", "memory", "summaries", "learned_character", "images", "context_tools", "profile_fields"])) }),
  z.object({ event: z.literal("chat.capabilities.resolved"), webSearchConfigured: z.enum(["off", "auto"]), webSearchEffective: z.enum(["off", "auto"]),
    nativeWebSearchSupported: z.boolean(), shadow: z.boolean(), recovery: z.boolean() }),
  z.object({ event: z.literal("context.background.validation"), purpose: z.enum(["summary", "memory_extraction"]), sources: count, status: z.enum(["current", "changed", "deadline"]) }),
  z.object({ event: z.literal("context.derived.excluded"), source: z.enum(["session", "bot_output"]), count, reason: z.literal("unverified_provenance") }),
  z.object({ event: z.literal("context.history.revalidated"), requested: count, selected: count, status: z.enum(["refreshed", "underfilled", "budget_exhausted", "changed"]) }),
  z.object({ event: z.literal("context.history.budget"), candidates: count, selected: count, truncated: count, omitted: count, budget: count, chars: count }),
  z.object({ event: z.literal("context.history.coverage"), requested: count, fetched: count, examined: count, eligible: count, pages: count,
    selectedIds: z.array(identifier).max(300), status: z.enum(["filled", "end", "scan_cap", "fetch_failed", "no_progress", "ineligible"]),
    omissions: z.object({ excluded: count, ineligible: count, unverifiable_bot: count, duplicate: count }) }),
  z.object({ event: z.literal("chat.decision.proposed"), wireRevision: z.number().int().positive(),
    relationship: z.enum(["followup", "group", "elsewhere", "unclear"]), referent: z.enum(["self_contained", "context_linked", "unresolved"]),
    action: z.enum(["reply", "react", "silent"]), intent: z.enum(["answer", "clarify", "social", "closing", "contribute", "abstain"]), evidenceCount: count,
    linkKind: z.enum(["speaker_exchange", "bot_reference", "reaction"]).nullable().optional(), recipientConfidence: z.number().min(0).max(1).optional(), confidence: z.number().min(0).max(1).optional() }),
  z.object({ event: z.literal("chat.decision.resolved"), stage: z.enum(["preflight", "generation"]), interaction: z.enum(["direct_mention", "explicit_reply", "bare_ping", "name_address", "implicit_followup", "group_conversation", "reaction"]), status: z.enum(["ready", "denied", "failed"]), recovery: z.enum(["none", "grounded_reply", "error_reply"]), decisionId: identifier, action: z.enum(["reply", "react", "reply_and_react", "silent"]), intent: z.enum(["answer", "clarify", "social", "closing", "contribute", "abstain"]), reason: identifier, contextVersion: identifier, policyVersion: identifier }),
  z.object({ event: z.literal("discord.rate_limit.summary"), caller: z.enum(["chat_text", "chat_reaction", "control_panel", "lyrics_panel", "queue_panel", "vote_panel", "now_playing_panel", "unknown"]), kind: z.enum(["response_429", "proactive_wait", "mixed"]), method: z.enum(["POST", "PATCH", "GET", "DELETE", "OTHER"]), channelId: identifier.optional(), targetMessageId: identifier.optional(), count, maxWaitMs: duration, overflow: z.boolean() }),
  z.object({ event: z.literal("chat.trace.interrupted"), reason: z.literal("previous_process_incomplete"), unfinishedSpans: count, unfinishedJobs: count, unfinishedOpportunities: count }),
  z.object({ event: z.literal("model.gateway.rejected"), purpose: identifier, phase: z.enum(["approval", "source", "result"]) }),
  z.object({ event: z.literal("model.operation.completed"), purpose: identifier, status: z.enum(["completed", "reported_failure", "failed"]), durationMs: duration, failure: failureCategory.optional(), httpStatus: z.number().int().min(100).max(599).optional() }),
  z.object({ event: z.literal("model.provider.attempt"), modelIndex: count, attempt: count, status: z.enum(["completed", "failed", "cooldown"]), durationMs: duration, failure: failureCategory.optional(), httpStatus: z.number().int().min(100).max(599).optional() }),
  z.object({ event: z.literal("chat.tool.completed"), status: z.enum(["completed", "failed", "timeout", "unknown_tool", "invalid_arguments"]), durationMs: duration, failure: failureCategory.optional() }),
  z.object({ event: z.literal("chat.gateway.received"), kind: z.enum(["message_created", "reaction_added"]), buildVersion: identifier, policyVersion: identifier }),
  z.object({ event: z.literal("chat.gateway.completed"), outcome: z.enum(["startup_gate", "control_channel", "dispatched", "out_of_scope", "failed"]), durationMs: duration, failure: failureCategory.optional() }),
  z.object({ event: z.literal("chat.ingress.received"), kind: z.enum(["message_created", "reaction_added", "voice_state_updated"]) }),
  z.object({ event: z.literal("chat.route.matched"), behaviorId: identifier }),
  z.object({ event: z.literal("chat.route.skipped"), behaviorId: identifier, reason: z.enum(["not_guild", "chat_disabled", "duplicate", "game_channel", "access_denied", "access_unavailable", "provider_unconfigured", "unresolved_reply_origin"]), accessReason: z.enum(["member_unavailable", "restricted_role", "channel_denied", "missing_chat_role"]).optional(), memberRefresh: z.enum(["current", "unavailable"]).optional() }),
  z.object({ event: z.literal("chat.dispatch.completed"), result: z.enum(["continue", "handled", "stop_propagation", "failed"]), behaviorId: identifier.optional(), stage: z.enum(["matches", "execute"]).optional(), durationMs: duration, failure: failureCategory.optional() }),
  z.object({ event: z.literal("context.eligibility.denied"), sourceMessageId: identifier, purpose: z.enum(["direct", "ambient", "continuation", "spontaneous", "reaction", "observation", "background_observation", "history_reaction", "history", "guarded_current"]), reason: eligibilityReason }),
  z.object({ event: z.literal("context.source.selected"), source: z.enum(["reply_chain", "channel_history"]), fetched: count, selected: count, omitted: count, status: z.enum(["complete", "ineligible", "fetch_failed", "bounded"]), chars: count }),
  z.object({ event: z.literal("context.selection.completed"), fetchedHistory: count, episodeCandidates: count, burstCandidates: count, merged: count, selected: count, replyChain: count, chars: count }),
  z.object({ event: z.literal("context.decision.coverage"), available: count, selected: count, required: count, omittedRequired: count }),
  z.object({ event: z.literal("context.selection.filtered"), reason: z.enum(["scope", "window", "gap", "segment", "count", "budget"]), before: count, after: count }),
  z.object({ event: z.literal("model.decision.attempt"), providerRole: z.enum(["primary", "fallback"]), attempt: count, status: z.enum(["valid", "failed"]), durationMs: duration, failure: failureCategory.optional(), httpStatus: z.number().int().min(100).max(599).optional(),
    inputTokens: count.optional(), outputTokens: count.optional(), totalTokens: count.optional(), cachedInputTokens: count.optional(), reasoningTokens: count.optional(),
    stage: z.enum(["context_validation", "model"]).optional(), contextDurationMs: duration.optional(), timeoutMs: duration.optional(),
    contractVersion: z.enum(["legacy", "contextual_v1"]).optional(), targetMode: z.enum(["fixed", "selectable"]).optional(), targetCandidates: count.optional(),
    wireRevision: z.number().int().positive().optional(),
    targetFailure: z.enum(["binding_missing", "choice_required", "unknown_choice"]).optional(),
    validationIssues: z.array(z.object({ field: z.string().min(1).max(128).refine((field) => field.split(".").every((part) => decisionValidationFields.includes(part))),
      code: z.enum(["invalid_type", "invalid_enum_value", "too_small", "too_big", "unrecognized_keys", "invalid"]) })).max(8).optional() }),
  z.object({ event: z.literal("chat.model.completed"), purpose: z.enum(["reply", "participation", "repair"]), status: z.enum(["valid", "failed"]), durationMs: duration, failure: failureCategory.optional(), httpStatus: z.number().int().min(100).max(599).optional() }),
  z.object({ event: z.literal("chat.turn.started"), triggerMode: trigger, candidateId: identifier.optional() }),
  z.object({ event: z.literal("chat.turn.plan"), flow: z.enum(["legacy", "contextual_v1"]), context: z.enum(["legacy", "guarded_text"]),
    state: z.enum(["ready", "blocked"]), reason: z.enum(["profile_unavailable", "context_disabled", "legacy_retrieval", "channel_context_disabled", "guard_unavailable", "guard_mismatch"]).optional() }),
  z.object({ event: z.literal("chat.candidate.source"), candidateId: identifier, sourceMessageId: identifier }),
  z.object({ event: z.literal("chat.turn.deadline"), budgetMs: duration }),
  z.object({ event: z.literal("chat.candidate.changed"), candidateId: identifier, action: z.enum(["buffered", "coalesced", "scheduled", "submitted", "cancelled", "expired"]), reason: z.enum(["accepted", "cooldown", "ready", "changed", "capacity", "ineligible", "deadline"]), messages: count, delayMs: duration }),
  z.object({ event: z.literal("chat.admission.buffered"), triggerMode: trigger, reason: z.enum(["batch_threshold", "pause_or_cooldown", "continuation_candidate", "submitted", "invalidated"]), messages: count, delayMs: duration }),
  z.object({ event: z.literal("chat.turn.skipped"), reason: z.enum(["decision_unavailable", "duplicate_ping"]) }),
  z.object({ event: z.literal("chat.output.suppressed"), reason: z.enum(["execution_ineligible", "privacy_changed", "shadow", "opportunity_expired", "context_changed", "delivery_cancelled", "output_capacity"]) }),
  z.object({ event: z.literal("chat.queue.changed"), jobId: identifier, action: z.enum(["enqueued", "admitted", "skipped", "cancelled", "completed", "failed"]),
    reason: z.enum(["accepted", "scheduler_closed", "replaced_by_optional", "preempted_by_direct", "channel_queue_full", "global_queue_full", "evaluation_cooldown", "evaluation_budget", "expired", "shutdown", "executed", "operation_failed", "operation_suppressed"]),
    optional: z.boolean(), queueDepth: count, waitMs: duration, failure: failureCategory.optional() }),
  z.object({ event: z.literal("chat.opportunity.changed"), opportunityId: identifier, previousOpportunityId: identifier.optional(),
    action: z.enum(["buffered", "coalesced", "flushed", "cancelled", "rejected"]),
    reason: z.enum(["coalescing", "ready", "superseded", "cancelled", "addressed_request", "privacy_changed", "source_invalidated", "capacity", "shutdown", "scheduler_closed"]), delayMs: duration }),
  z.object({ event: z.literal("chat.output.reservation"), reservationId: identifier, kind: z.enum(["text", "reaction"]), optional: z.boolean(), continuation: z.boolean(),
    status: z.enum(["reserved", "denied", "committed", "released"]),
    reason: z.enum(["direct", "available", "in_flight", "exchange_limit", "channel_limit", "cooldown", "capacity", "delivered", "not_delivered"]) }),
  z.object({ event: z.literal("chat.turn.completed"), triggerMode: trigger, outcome: z.enum(["text_delivered", "no_text_delivery", "suppressed", "failed", "delivered_state_unsaved"]), durationMs: duration, textDeliveryConfirmed: z.boolean(), failure: failureCategory.optional() }),
  z.object({ event: z.literal("chat.delivery.completed"), plannedParts: count, deliveredParts: count, status: z.enum(["complete", "partial", "failed", "suppressed"]), failure: failureCategory.optional() }),
  z.object({ event: z.literal("chat.delivery.part"), deliveredMessageId: identifier, part: count }),
]);

export type ChatDiagnosticEvent = z.infer<typeof eventSchema>;
export type DiagnosticLogger = Pick<Logger, "info" | "warn">;

export interface DiagnosticScopeInput {
  operation: "gateway" | "dispatch" | "chat_turn" | "model";
  guildId?: string | undefined;
  channelId?: string | undefined;
  sourceMessageId?: string | undefined;
}
interface DiagnosticScope extends DiagnosticScopeInput {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceSequence: number;
}
const scopes = new AsyncLocalStorage<DiagnosticScope | undefined>();
const scopeInputSchema = z.object({ operation: z.enum(["gateway", "dispatch", "chat_turn", "model"]), guildId: identifier.optional(), channelId: identifier.optional(), sourceMessageId: identifier.optional() });
export const chatDiagnosticRecordSchema = z.object({
  schemaVersion: z.literal(1), processRunId: identifier, timestampMs: count, eventSequence: count,
  scope: scopeInputSchema.extend({ traceId: identifier, spanId: identifier, parentSpanId: identifier.optional(), traceSequence: count }),
  data: eventSchema,
});
export type ChatDiagnosticRecord = z.infer<typeof chatDiagnosticRecordSchema>;

// Pino child loggers inherit their parent's properties. A non-enumerable symbol
// keeps this per-instance store available without serializing it into logs.
export function attachDiagnosticStore(logger: DiagnosticLogger, store: ChatTraceStore): void {
  Object.defineProperty(logger, diagnosticStoreKey, { value: store, configurable: true });
  Object.defineProperty(logger, pipelineKey, { value: logger, configurable: true });
}

export function diagnosticStore(logger: DiagnosticLogger | null): ChatTraceStore | null {
  return logger ? (logger as DiagnosticLogger & { [diagnosticStoreKey]?: ChatTraceStore })[diagnosticStoreKey] ?? null : null;
}

export function currentDiagnosticTraceSequence(): number { return traceSequence; }

export function diagnosticFields(): Readonly<DiagnosticScope> | Record<string, never> {
  const scope = scopes.getStore();
  return scope ? { ...scope } : {};
}

export function withoutDiagnosticScope<T>(task: () => T): T { return scopes.run(undefined, task); }

export function withDiagnosticScope<T>(input: DiagnosticScopeInput, task: () => T): T {
  const parent = scopes.getStore();
  const parsed = scopeInputSchema.safeParse(input);
  const scope: DiagnosticScope = {
    ...(parsed.success ? parsed.data : { operation: "dispatch" as const }), traceId: parent?.traceId ?? randomUUID(), spanId: randomUUID(),
    traceSequence: parent?.traceSequence ?? ++traceSequence,
    ...(parent ? { parentSpanId: parent.spanId } : {}),
  };
  return scopes.run(scope, task);
}

// Queues can execute a task from another request's async context. Capture the
// submitter explicitly rather than inheriting whichever task pumps the queue.
export function bindDiagnosticTask<Args extends unknown[], T>(task: (...args: Args) => T): (...args: Args) => T {
  const scope = scopes.getStore();
  return (...args) => scopes.run(scope, () => task(...args));
}

export function diagnosticElapsed(start: number): number {
  return Math.max(0, performance.now() - start);
}

export function emitChatDiagnostic(logger: DiagnosticLogger | null, event: ChatDiagnosticEvent): void {
  if (!logger) return;
  const health = pipelineStatus(logger); health.attempted++;
  try {
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success) { health.invalidEvents++; return; }
    const scope = scopes.getStore();
    const sequence = ++eventSequence;
    if (scope?.guildId && scope.channelId && scope.sourceMessageId) {
      try {
        diagnosticStore(logger)?.record({ schemaVersion: 1, processRunId: diagnosticProcessRunId,
          timestampMs: Date.now(), eventSequence: sequence, scope: { ...scope }, data: parsed.data });
      } catch { health.retentionFailures++; }
    } else health.unscopedEvents++;
    const fields = { schemaVersion: 1, ...scope, eventSequence: sequence, ...parsed.data };
    if (("failure" in parsed.data && parsed.data.failure) || parsed.data.event === "discord.rate_limit.summary") logger.warn(fields, parsed.data.event);
    else logger.info(fields, parsed.data.event);
  } catch {
    health.logFailures++;
    // Telemetry must never change authorization, retries, or visible delivery.
  }
}

// Only structural, allow-listed metadata is safe. Never serialize message,
// stack, response body, cause, URL, provider code, or an arbitrary error name.
export function safeFailure(error: unknown, fallback: "provider_error" | "operation_error" = "provider_error"): { failure: FailureCategory; httpStatus?: number } {
  try {
    if (error instanceof SyntaxError) return { failure: "invalid_json" };
    if (error instanceof z.ZodError) return { failure: "schema_mismatch" };
    const parsed = z.object({ name: z.unknown(), status: z.unknown(), code: z.unknown() }).safeParse(error);
    if (!parsed.success) return { failure: fallback };
    const { name, status, code } = parsed.data;
    // DOMException has a numeric `code`, unlike transport errors. Inspect
    // fields independently so that does not mask its TimeoutError name.
    if (name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return { failure: "timeout" };
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return { failure: status === 429 ? "rate_limited" : "http_error", httpStatus: status };
    if (code === "incomplete_response") return { failure: "incomplete_response" };
    if (code === "invalid_structured_output") return { failure: "schema_mismatch" };
    if (name === "TypeError" || code === "ECONNRESET" || code === "ENOTFOUND") return { failure: "transport_error" };
  } catch { /* Error metadata may itself have throwing accessors. */ }
  return { failure: fallback };
}
