import type { RetainedChatTrace } from "./chat-trace-store.js";
import type { ChatDiagnosticEvent } from "./chat-diagnostics.js";

export type ChatExplanationOutcome = "no_record" | "delivered" | "delivery_observed" | "partial_delivery" | "delivered_unsaved" | "reacted" |
  "intentional_silence" | "access_denied" | "feature_disabled" | "duplicate" | "source_invalidated" | "suppressed" |
  "provider_failed" | "delivery_failed" | "failed" | "interrupted_unknown" | "incomplete";
export interface ChatExplanation {
  outcome: ChatExplanationOutcome;
  trace: RetainedChatTrace | null;
  reason: string | null;
  partialEvidence: boolean;
  earlierDeliveryObserved: boolean;
  context: { selected: number; requested: number | null; status: string | null } | null;
  modelFailures: number;
  fallbackObserved: boolean;
  bookkeepingFailures: number;
  unavailable: Extract<ChatDiagnosticEvent, { event: "context.guard.sources" }>["unavailable"];
}

const newestAt = (trace: RetainedChatTrace): number => Math.max(0, ...trace.records.map((record) => record.timestampMs));
const confirmed = (event: ChatDiagnosticEvent): boolean => event.event === "chat.delivery.part" ||
  event.event === "chat.delivery.completed" && event.deliveredParts > 0 || event.event === "chat.turn.completed" && event.textDeliveryConfirmed;

// Explain recorded facts only. In particular, missing events or no_text_delivery
// cannot establish deliberate silence, privacy denial, or successful delivery.
export function explainChatTrace(traces: readonly RetainedChatTrace[]): ChatExplanation {
  const trace = [...traces].sort((a, b) => newestAt(a) - newestAt(b)).at(-1) ?? null;
  const result: ChatExplanation = { outcome: "no_record", trace, reason: null, partialEvidence: false,
    earlierDeliveryObserved: false, context: null, modelFailures: 0, fallbackObserved: false, bookkeepingFailures: 0, unavailable: [] };
  if (!trace) return result;
  const events = [...trace.records].sort((a, b) => a.timestampMs - b.timestampMs || a.eventSequence - b.eventSequence).map((record) => record.data);
  result.partialEvidence = trace.truncated;
  result.earlierDeliveryObserved = traces.some((other) => other !== trace && other.records.some((record) => confirmed(record.data)));
  for (const event of events) {
    if (event.event === "chat.delivery.bookkeeping_failed") result.bookkeepingFailures++;
    if (event.event === "context.guard.sources") result.unavailable = event.unavailable;
    if (event.event === "context.guard.coverage") result.context = { selected: event.selected, requested: event.requested, status: event.status };
    else if (event.event === "context.history.coverage") result.context = { selected: event.selectedIds.length, requested: event.requested, status: event.status };
    else if (event.event === "context.selection.completed" && !result.context) result.context = { selected: event.selected, requested: null, status: null };
    if (event.event === "model.decision.attempt" && event.status === "failed" || event.event === "chat.model.completed" && event.status === "failed" ||
      event.event === "model.provider.attempt" && event.status === "failed") result.modelFailures++;
    if (event.event === "model.decision.attempt" && event.providerRole === "fallback" || event.event === "model.provider.attempt" && event.modelIndex > 0 ||
      event.event === "chat.decision.resolved" && event.recovery === "grounded_reply") result.fallbackObserved = true;
  }
  const last = <T extends ChatDiagnosticEvent["event"]>(name: T): Extract<ChatDiagnosticEvent, { event: T }> | undefined =>
    events.findLast((event): event is Extract<ChatDiagnosticEvent, { event: T }> => event.event === name);
  const turn = last("chat.turn.completed"); const delivery = last("chat.delivery.completed");
  const decision = last("chat.decision.resolved"); const suppressed = last("chat.output.suppressed");
  const validation = last("context.guard.validation"); const coverage = last("context.guard.coverage");
  const eligibility = events.findLast((event) => event.event === "context.eligibility.denied" &&
    event.sourceMessageId === trace.records[0]?.scope.sourceMessageId && !["history", "history_reaction", "observation", "background_observation"].includes(event.purpose));
  const route = last("chat.route.skipped");
  const gateway = last("chat.gateway.completed"); const queue = last("chat.queue.changed");
  const candidate = last("chat.candidate.changed"); const deadline = last("chat.turn.deadline");
  const hasDelivery = events.some(confirmed);
  if (turn?.outcome === "delivered_state_unsaved") result.outcome = "delivered_unsaved";
  else if (delivery?.status === "partial" && delivery.deliveredParts > 0) result.outcome = "partial_delivery";
  else if (turn?.outcome === "text_delivered" && turn.textDeliveryConfirmed || delivery?.status === "complete" && delivery.deliveredParts > 0) result.outcome = "delivered";
  else if (hasDelivery) result.outcome = "delivery_observed";
  else if (delivery?.status === "failed") { result.outcome = "delivery_failed"; result.reason = delivery.failure ?? null; }
  else if (deadline) { result.outcome = "suppressed"; result.reason = "turn_deadline"; }
  else if (turn?.outcome === "failed") { result.outcome = "failed"; result.reason = turn.failure ?? null; }
  else if (last("chat.trace.interrupted")) result.outcome = "interrupted_unknown";
  else if (validation?.status === "changed") { result.outcome = "source_invalidated"; result.reason = "context_changed"; }
  else if (coverage && ["deadline", "source_ineligible", "ineligible_reaction"].includes(coverage.status)) { result.outcome = "suppressed"; result.reason = coverage.status; }
  else if (suppressed) { result.outcome = ["privacy_changed", "context_changed"].includes(suppressed.reason) ? "source_invalidated" : "suppressed"; result.reason = suppressed.reason; }
  else if (eligibility?.event === "context.eligibility.denied") {
    result.outcome = ["chat_disabled", "continuation_disabled", "spontaneous_disabled", "ambient_disabled", "reaction_disabled", "history_reactions_disabled"].includes(eligibility.reason) ? "feature_disabled" :
      ["access_denied", "passive_access_denied", "passive_scope_denied", "channel_denied", "background_scope_denied"].includes(eligibility.reason) ? "access_denied" : "suppressed";
    result.reason = eligibility.reason;
  }
  else if (decision?.status === "failed" || decision?.recovery === "error_reply") { result.outcome = "provider_failed"; result.reason = decision.reason; }
  else if (last("chat.model.completed")?.status === "failed" && events.findLastIndex((event) => event.event === "chat.model.completed") > events.findLastIndex((event) => event.event === "chat.decision.resolved")) {
    result.outcome = "provider_failed"; result.reason = last("chat.model.completed")?.failure ?? null;
  }
  else if (events.some((event) => event.event === "chat.output.reservation" && event.kind === "reaction" && event.status === "committed")) result.outcome = "reacted";
  else if (decision?.action === "silent") { result.outcome = decision.status === "denied" ? "suppressed" : decision.reason === "duplicate_ping" ? "duplicate" : "intentional_silence"; result.reason = decision.reason; }
  else if (route) { result.outcome = route.reason === "duplicate" ? "duplicate" : route.reason === "access_denied" ? "access_denied" : route.reason === "chat_disabled" ? "feature_disabled" : "suppressed"; result.reason = route.reason; }
  else if (gateway && gateway.outcome !== "dispatched") { result.outcome = gateway.outcome === "failed" ? "failed" : "suppressed"; result.reason = gateway.outcome; }
  else if (queue && ["skipped", "cancelled", "failed"].includes(queue.action)) { result.outcome = "suppressed"; result.reason = queue.reason; }
  else if (candidate) { result.outcome = ["cancelled", "expired"].includes(candidate.action) ? "suppressed" : "incomplete";
    result.reason = candidate.action === "expired" ? "candidate_expired" : candidate.reason === "cooldown" ? "candidate_cooldown" : `candidate_${candidate.action}`; }
  else result.outcome = "incomplete";
  // A valid generated silent decision followed by a recorded failure is not
  // intentional silence. A failed attempt later recovered is still visible.
  if (result.outcome === "failed" && turn?.failure && ["timeout", "http_error", "invalid_json", "schema_mismatch", "incomplete_response", "transport_error", "provider_error", "provider_cooldown"].includes(turn.failure)) result.outcome = "provider_failed";
  return result;
}
