import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Logger } from "pino";
import { z } from "zod";

const count = z.number().int().nonnegative();
const duration = z.number().finite().nonnegative();
const identifier = z.string().min(1).max(128).regex(/^[\w.:-]+$/u);
const trigger = z.enum(["direct", "ambient", "continuation", "spontaneous", "reaction"]);
export const eligibilityReason = z.enum(["not_guild", "chat_disabled", "needs_conversation_context", "background_scope_denied", "passive_scope_denied", "passive_access_denied", "game_channel", "continuation_disabled", "spontaneous_disabled", "history_reactions_disabled", "ambient_disabled", "reaction_disabled", "utility_or_unknown_bot_output", "channel_denied", "access_denied", "utility_interaction", "cyclic_reply_chain", "unknown_bot_output", "utility_reply", "cross_channel_reply", "unresolved_reply_origin", "reply_depth_limit"]);

export const failureCategory = z.enum([
  "timeout", "http_error", "rate_limited", "invalid_json", "schema_mismatch",
  "incomplete_response", "transport_error", "provider_error", "operation_error", "invalid_target",
  "fixed_target_mismatch", "invalid_boundary", "invalid_evidence", "invalid_contribution",
  "invalid_thought", "recipient_mismatch",
]);
export type FailureCategory = z.infer<typeof failureCategory>;

// Allow-list every serialized field. Runtime stripping also protects callers
// compiled without TypeScript, and prevents raw provider/Discord objects leaking.
const eventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("chat.ingress.received"), kind: z.enum(["message_created", "reaction_added", "voice_state_updated"]) }),
  z.object({ event: z.literal("chat.route.matched"), behaviorId: identifier }),
  z.object({ event: z.literal("chat.dispatch.completed"), result: z.enum(["continue", "handled", "stop_propagation", "failed"]), behaviorId: identifier.optional(), stage: z.enum(["matches", "execute"]).optional(), durationMs: duration, failure: failureCategory.optional() }),
  z.object({ event: z.literal("context.eligibility.denied"), sourceMessageId: identifier, purpose: z.enum(["direct", "ambient", "continuation", "spontaneous", "reaction", "observation", "background_observation", "history_reaction"]), reason: eligibilityReason }),
  z.object({ event: z.literal("context.source.selected"), source: z.enum(["reply_chain", "channel_history"]), fetched: count, selected: count, omitted: count, status: z.enum(["complete", "ineligible", "fetch_failed", "bounded"]), chars: count }),
  z.object({ event: z.literal("context.selection.completed"), fetchedHistory: count, episodeCandidates: count, burstCandidates: count, merged: count, selected: count, replyChain: count, chars: count }),
  z.object({ event: z.literal("context.selection.filtered"), reason: z.enum(["scope", "window", "gap", "segment", "count", "budget"]), before: count, after: count }),
  z.object({ event: z.literal("model.decision.attempt"), providerRole: z.enum(["primary", "fallback"]), attempt: count, status: z.enum(["valid", "failed"]), durationMs: duration, failure: failureCategory.optional(), httpStatus: z.number().int().min(100).max(599).optional() }),
  z.object({ event: z.literal("chat.model.completed"), purpose: z.enum(["reply", "participation", "repair"]), status: z.enum(["valid", "failed"]), durationMs: duration, failure: failureCategory.optional(), httpStatus: z.number().int().min(100).max(599).optional() }),
  z.object({ event: z.literal("chat.turn.started"), triggerMode: trigger }),
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
]);

export type ChatDiagnosticEvent = z.infer<typeof eventSchema>;
export type DiagnosticLogger = Pick<Logger, "info" | "warn">;

export interface DiagnosticScopeInput {
  operation: "dispatch" | "chat_turn";
  guildId?: string | undefined;
  channelId?: string | undefined;
  sourceMessageId?: string | undefined;
}
interface DiagnosticScope extends DiagnosticScopeInput {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}
const scopes = new AsyncLocalStorage<DiagnosticScope | undefined>();
const scopeInputSchema = z.object({ operation: z.enum(["dispatch", "chat_turn"]), guildId: identifier.optional(), channelId: identifier.optional(), sourceMessageId: identifier.optional() });

export function diagnosticFields(): Readonly<DiagnosticScope> | Record<string, never> {
  const scope = scopes.getStore();
  return scope ? { ...scope } : {};
}

export function withDiagnosticScope<T>(input: DiagnosticScopeInput, task: () => T): T {
  const parent = scopes.getStore();
  const parsed = scopeInputSchema.safeParse(input);
  const scope: DiagnosticScope = {
    ...(parsed.success ? parsed.data : { operation: "dispatch" as const }), traceId: parent?.traceId ?? randomUUID(), spanId: randomUUID(),
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
  try {
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success) return;
    const scope = scopes.getStore();
    const fields = { schemaVersion: 1, ...scope, ...parsed.data };
    if ("failure" in parsed.data && parsed.data.failure) logger.warn(fields, parsed.data.event);
    else logger.info(fields, parsed.data.event);
  } catch {
    // Telemetry must never change authorization, retries, or visible delivery.
    // Sink loss accounting and durable trace storage are a later phase.
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
