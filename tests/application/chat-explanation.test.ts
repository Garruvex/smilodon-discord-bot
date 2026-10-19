import { describe, expect, it } from "vitest";
import { explainChatTrace, type ChatExplanationOutcome } from "../../src/application/diagnostics/chat-explanation.js";
import type { ChatDiagnosticEvent } from "../../src/application/diagnostics/chat-diagnostics.js";
import type { RetainedChatTrace } from "../../src/application/diagnostics/chat-trace-store.js";
import { renderChatExplanation } from "../../src/application/i18n/chat-explanation.js";
import { diagnosticRecord } from "../helpers/chat-trace-fixtures.js";

const decision = (status: "ready" | "failed" = "ready"): ChatDiagnosticEvent => ({ event: "chat.decision.resolved", stage: "generation", interaction: "bare_ping", status,
  recovery: "none", decisionId: "decision", action: "silent", intent: "abstain", reason: status === "failed" ? "no_valid_decision" : "no_contribution", contextVersion: "v1", policyVersion: "v1" });
const turn = (outcome: "no_text_delivery" | "text_delivered" | "delivered_state_unsaved" | "failed"): ChatDiagnosticEvent => ({ event: "chat.turn.completed", triggerMode: "direct", outcome,
  textDeliveryConfirmed: outcome === "text_delivered" || outcome === "delivered_state_unsaved", durationMs: 10 });
function trace(events: ChatDiagnosticEvent[], overrides: Partial<RetainedChatTrace> = {}): RetainedChatTrace {
  return { traceId: "trace", processRunId: "run", truncated: false,
    records: events.map((data, index) => diagnosticRecord({ data, timestampMs: index + 1000, eventSequence: index + 1 })), ...overrides };
}

describe("recorded chat explanations", () => {
  const cases: [string, ChatDiagnosticEvent[], ChatExplanationOutcome][] = [
    ["valid silence", [decision(), turn("no_text_delivery")], "intentional_silence"],
    ["failed decision must not look intentional", [decision("failed"), turn("no_text_delivery")], "provider_failed"],
    ["missing decision is unknown", [turn("no_text_delivery")], "incomplete"],
    ["confirmed delivery", [turn("text_delivered")], "delivered"],
    ["unsaved delivery", [turn("delivered_state_unsaved")], "delivered_unsaved"],
    ["partial delivery even if turn reports text", [{ event: "chat.delivery.completed", plannedParts: 3, deliveredParts: 1, status: "partial" }, turn("text_delivered")], "partial_delivery"],
    ["a part alone does not establish completion", [{ event: "chat.delivery.part", deliveredMessageId: "part", part: 1 }], "delivery_observed"],
    ["failed delivery", [{ event: "chat.delivery.completed", plannedParts: 1, deliveredParts: 0, status: "failed", failure: "http_error" }, turn("failed")], "delivery_failed"],
    ["source changed", [{ event: "chat.output.suppressed", reason: "context_changed" }], "source_invalidated"],
    ["duplicate", [{ event: "chat.route.skipped", behaviorId: "mention", reason: "duplicate" }], "duplicate"],
    ["access denial", [{ event: "context.eligibility.denied", sourceMessageId: "source", purpose: "direct", reason: "access_denied" }], "access_denied"],
    ["feature off", [{ event: "context.eligibility.denied", sourceMessageId: "source", purpose: "direct", reason: "chat_disabled" }], "feature_disabled"],
    ["reaction confirmed", [{ event: "chat.output.reservation", reservationId: "reservation", kind: "reaction", optional: true, continuation: false, status: "committed", reason: "delivered" }], "reacted"],
    ["interrupted silence is still unknown", [decision(), { event: "chat.trace.interrupted", reason: "previous_process_incomplete", unfinishedSpans: 1, unfinishedJobs: 0, unfinishedOpportunities: 0 }], "interrupted_unknown"],
    ["model failure after a silent decision", [decision(), { event: "chat.model.completed", purpose: "reply", status: "failed", failure: "timeout", durationMs: 20 }], "provider_failed"],
  ];
  it.each(cases)("explains %s", (_name, events, outcome) => {
    expect(explainChatTrace([trace(events)]).outcome).toBe(outcome);
  });

  it("does not turn historical exclusions into current-request privacy denials", () => {
    const result = explainChatTrace([trace([{ event: "context.eligibility.denied", sourceMessageId: "bob-old", purpose: "guarded_current", reason: "access_denied" }, decision(), turn("no_text_delivery")])]);
    expect(result.outcome).toBe("intentional_silence"); expect(result.reason).toBe("no_contribution");
  });

  it("selects the newest evidence group by time and reports deliveries from other attempts", () => {
    const older = trace([turn("text_delivered")]);
    const newer = trace([{ event: "chat.route.skipped", behaviorId: "mention", reason: "duplicate" }], { traceId: "newer" });
    newer.records[0]!.timestampMs = 2000;
    const result = explainChatTrace([newer, older]);
    expect(result.trace?.traceId).toBe("newer"); expect(result.outcome).toBe("duplicate"); expect(result.earlierDeliveryObserved).toBe(true);
  });

  it("preserves failed attempts and fallback observations after successful delivery", () => {
    const result = explainChatTrace([trace([
      { event: "model.decision.attempt", providerRole: "primary", attempt: 1, status: "failed", failure: "timeout", durationMs: 6000 },
      { event: "model.decision.attempt", providerRole: "fallback", attempt: 2, status: "valid", durationMs: 100 },
      { event: "context.history.coverage", requested: 40, fetched: 100, examined: 100, eligible: 12, pages: 1, selectedIds: ["old"], status: "scan_cap", omissions: { excluded: 0, ineligible: 88, unverifiable_bot: 0, duplicate: 0 } }, turn("text_delivered"),
      { event: "context.guard.sources", sessions: 0, unavailable: ["legacy_derived", "memory", "summaries", "learned_character", "images", "context_tools", "profile_fields"] },
    ], { truncated: true })]);
    expect(result).toMatchObject({ outcome: "delivered", modelFailures: 1, fallbackObserved: true, partialEvidence: true, context: { selected: 1, requested: 40, status: "scan_cap" } });
    for (const language of ["en", "zh-TW", "ja"] as const) {
      const text = renderChatExplanation(result, language); expect(text.length).toBeLessThan(800); expect(text).not.toContain("undefined");
    }
  });

  it("never turns missing or contradictory records into confirmed delivery", () => {
    expect(explainChatTrace([]).outcome).toBe("no_record");
    expect(renderChatExplanation(explainChatTrace([]))).toContain("does not prove the bot never received it");
    const result = explainChatTrace([trace([{ ...turn("text_delivered"), textDeliveryConfirmed: false } as ChatDiagnosticEvent])]);
    expect(result.outcome).toBe("incomplete");
  });

  it("keeps confirmed delivery separate from failed metadata recording", () => {
    const result = explainChatTrace([trace([{ event: "chat.delivery.bookkeeping_failed", stage: "origin", failure: "operation_error" }, turn("text_delivered")])]);
    expect(result.outcome).toBe("delivered"); expect(result.bookkeepingFailures).toBe(1);
    expect(renderChatExplanation(result)).toContain("may be unavailable as future context");
  });
});
