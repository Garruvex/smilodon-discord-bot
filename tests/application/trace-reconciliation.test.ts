import { describe, expect, it } from "vitest";
import { reconcileTrace } from "../../src/application/diagnostics/trace-reconciliation.js";
import type { RetainedChatTrace } from "../../src/application/diagnostics/chat-trace-store.js";
import { diagnosticRecord } from "../helpers/chat-trace-fixtures.js";

function previousTrace(): RetainedChatTrace {
  return { processRunId: "old-process", traceId: "trace", truncated: false, records: [diagnosticRecord({ processRunId: "old-process" })] };
}
describe("restart reconciliation", () => {
  it("marks an incomplete prior process once without claiming delivery failed", () => {
    const trace = previousTrace(); const marker = reconcileTrace(trace, 2000)!;
    expect(marker.data).toEqual({ event: "chat.trace.interrupted", reason: "previous_process_incomplete", unfinishedSpans: 1, unfinishedJobs: 0, unfinishedOpportunities: 0 });
    expect(reconcileTrace({ ...trace, records: [...trace.records, marker] }, 3000)).toBeNull();
  });
  it("does not mark completed or current-process traces", () => {
    const trace = previousTrace();
    expect(reconcileTrace({ ...trace, records: [...trace.records, diagnosticRecord({ processRunId: "old-process", data: { event: "chat.turn.completed", triggerMode: "direct", outcome: "text_delivered", durationMs: 1, textDeliveryConfirmed: true } })] }, 2000)).toBeNull();
    expect(reconcileTrace({ ...trace, processRunId: diagnosticRecord().processRunId }, 2000)).toBeNull();
  });
  it("detects pending queue work after dispatch already completed", () => {
    const record = diagnosticRecord({ processRunId: "old-process", data: { event: "chat.queue.changed", jobId: "job", action: "enqueued", reason: "accepted", optional: false, queueDepth: 1, waitMs: 0 } });
    const marker = reconcileTrace({ ...previousTrace(), records: [record] }, 2000);
    expect(marker?.data).toMatchObject({ unfinishedSpans: 0, unfinishedJobs: 1 });
    expect(reconcileTrace({ ...previousTrace(), records: [record, { ...record, data: { ...record.data, event: "chat.queue.changed", jobId: "job", action: "cancelled", reason: "shutdown", optional: false, queueDepth: 0, waitMs: 0 } }] }, 2000)).toBeNull();
  });
});
