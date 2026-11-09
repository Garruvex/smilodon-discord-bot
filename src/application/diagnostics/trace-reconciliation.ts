import { diagnosticProcessRunId, type ChatDiagnosticRecord } from "./chat-diagnostics.js";
import type { RetainedChatTrace } from "./chat-trace-store.js";

// A missing terminal is evidence of interruption OR lost diagnostics. Never
// infer intentional silence, failed delivery, or permission to replay a send.
export function reconcileTrace(trace: RetainedChatTrace, now: number): ChatDiagnosticRecord | null {
  if (trace.processRunId === diagnosticProcessRunId || trace.records.some((record) => record.data.event === "chat.trace.interrupted")) return null;
  const spans = new Set<string>(); const jobs = new Set<string>(); const opportunities = new Set<string>();
  for (const record of trace.records) {
    const event = record.data;
    if (["chat.gateway.received", "chat.ingress.received", "chat.turn.started"].includes(event.event)) spans.add(record.scope.spanId);
    if (["chat.gateway.completed", "chat.dispatch.completed", "chat.turn.completed"].includes(event.event)) spans.delete(record.scope.spanId);
    if (event.event === "chat.queue.changed") {
      if (event.action === "enqueued" || event.action === "admitted") jobs.add(event.jobId); else jobs.delete(event.jobId);
    }
    if (event.event === "chat.opportunity.changed") {
      if (event.previousOpportunityId) opportunities.delete(event.previousOpportunityId);
      if (event.action === "buffered" || event.action === "coalesced") opportunities.add(event.opportunityId); else opportunities.delete(event.opportunityId);
    }
  }
  const last = trace.records.at(-1);
  if (!last || !(spans.size + jobs.size + opportunities.size)) return null;
  return { ...last, timestampMs: now, eventSequence: Math.max(...trace.records.map((record) => record.eventSequence)) + 1,
    data: { event: "chat.trace.interrupted", reason: "previous_process_incomplete", unfinishedSpans: spans.size, unfinishedJobs: jobs.size, unfinishedOpportunities: opportunities.size } };
}
