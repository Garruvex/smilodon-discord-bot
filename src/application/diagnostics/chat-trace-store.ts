import { chatDiagnosticRecordSchema, diagnosticProcessRunId, type ChatDiagnosticRecord } from "./chat-diagnostics.js";

export interface TraceQuery { guildId: string; channelId: string; sourceMessageId: string }
export interface RetainedChatTrace {
  traceId: string;
  processRunId: string;
  records: readonly ChatDiagnosticRecord[];
  truncated: boolean;
}
export interface TraceStoreStatus {
  traces: number; events: number; bytes: number;
  droppedTraces: number; droppedEvents: number; invalidRecords: number; expiredTraces: number;
  writeFailures: number;
}
export interface ChatTraceStore {
  record(record: ChatDiagnosticRecord): void;
  lookup(query: TraceQuery): readonly RetainedChatTrace[];
  status(): TraceStoreStatus;
  forgetGuild(guildId: string, beforeSequence: number): Promise<void>;
  excludeSource(query: TraceQuery, beforeSequence: number): void;
  flush(): Promise<void>;
}
export interface TraceStoreLimits {
  retentionMs: number;
  maxTraces: number;
  maxTracesPerGuild: number;
  maxEvents: number;
  maxEventsPerTrace: number;
  maxBytes: number;
}
export const defaultTraceStoreLimits: Readonly<TraceStoreLimits> = {
  retentionMs: 24 * 60 * 60_000, maxTraces: 1000, maxTracesPerGuild: 200,
  maxEvents: 20_000, maxEventsPerTrace: 200, maxBytes: 4 * 1024 * 1024,
};
interface StoredTrace {
  traceId: string; processRunId: string; guildId: string; channelId: string; sourceMessageId: string;
  records: ChatDiagnosticRecord[]; sizes: number[]; bytes: number; lastAt: number; truncated: boolean;
}

// Contains no raw chat text. Authorization is enforced by the diagnostic lookup
// adapter; this internal repository always requires an exact guild/channel key.
export class BoundedChatTraceBuffer {
  private readonly traces = new Map<string, StoredTrace>();
  private readonly guildCutoffs = new Map<string, number>();
  private readonly sourceCutoffs = new Map<string, number>();
  private readonly excludedSequences = new Set<number>();
  private globalCutoff = -1;
  private bytes = 0;
  private events = 0;
  private droppedTraces = 0;
  private droppedEvents = 0;
  private invalidRecords = 0;
  private expiredTraces = 0;
  public readonly limits: Readonly<TraceStoreLimits>;

  public constructor(limits: Partial<TraceStoreLimits> = {}, private readonly now: () => number = Date.now) {
    this.limits = { ...defaultTraceStoreLimits, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid diagnostic retention limit");
  }

  public record(input: unknown): boolean {
    const parsed = chatDiagnosticRecordSchema.safeParse(input);
    if (!parsed.success) { this.invalidRecords++; return false; }
    const record = parsed.data;
    const { guildId, channelId, sourceMessageId } = record.scope;
    if (!guildId || !channelId || !sourceMessageId || record.timestampMs > this.now() || record.timestampMs <= this.now() - this.limits.retentionMs) return false;
    if (record.processRunId === diagnosticProcessRunId && record.scope.traceSequence <= Math.max(this.globalCutoff, this.guildCutoffs.get(guildId) ?? -1)) return false;
    if (record.processRunId === diagnosticProcessRunId) {
      const sources = [sourceMessageId];
      if ("sourceMessageId" in record.data) sources.push(record.data.sourceMessageId);
      if ("deliveredMessageId" in record.data) sources.push(record.data.deliveredMessageId);
      if (this.excludedSequences.has(record.scope.traceSequence) || sources.some((id) => record.scope.traceSequence <=
        (this.sourceCutoffs.get(JSON.stringify([guildId, channelId, id])) ?? -1))) return false;
    }
    this.prune();
    const size = Buffer.byteLength(JSON.stringify(record), "utf8");
    if (size > this.limits.maxBytes) { this.droppedEvents++; return false; }
    const key = JSON.stringify([record.processRunId, record.scope.traceId, guildId, channelId, sourceMessageId]);
    let trace = this.traces.get(key);
    // A coalesced turn can inherit a trace while changing its source event.
    // Retain separate source groups so lookup never exposes another channel.
    if (!trace) {
      trace = { traceId: record.scope.traceId, processRunId: record.processRunId, guildId, channelId, sourceMessageId,
        records: [], sizes: [], bytes: 0, lastAt: record.timestampMs,
        truncated: record.data.event !== "chat.ingress.received" && record.data.event !== "chat.turn.started" };
      this.traces.set(key, trace);
    }
    trace.records.push(record); trace.sizes.push(size); trace.bytes += size;
    trace.lastAt = Math.max(trace.lastAt, record.timestampMs);
    this.bytes += size; this.events++;
    while (trace.records.length > this.limits.maxEventsPerTrace) {
      trace.records.shift(); const removedSize = trace.sizes.shift()!;
      trace.bytes -= removedSize; this.bytes -= removedSize; this.events--;
      this.droppedEvents++; trace.truncated = true;
    }
    // FIFO eviction is intentional: refreshing a noisy trace cannot pin it
    // forever and evict every other channel's latest diagnostic record.
    const guildKeys = [...this.traces].filter(([, entry]) => entry.guildId === guildId).map(([id]) => id);
    while (guildKeys.length > this.limits.maxTracesPerGuild) this.remove(guildKeys.shift()!, "capacity");
    while (this.traces.size > this.limits.maxTraces || this.events > this.limits.maxEvents || this.bytes > this.limits.maxBytes)
      this.remove(this.traces.keys().next().value!, "capacity");
    return true;
  }

  public prune(): void {
    const cutoff = this.now() - this.limits.retentionMs;
    for (const [key, trace] of this.traces) {
      if (trace.lastAt <= cutoff) { this.remove(key, "expired"); continue; }
      for (let index = trace.records.length - 1; index >= 0; index--) {
        if (trace.records[index]!.timestampMs > cutoff) continue;
        trace.records.splice(index, 1); const size = trace.sizes.splice(index, 1)[0]!;
        trace.bytes -= size; this.bytes -= size; this.events--; trace.truncated = true;
      }
      if (!trace.records.length) this.remove(key, "expired");
      else trace.lastAt = Math.max(...trace.records.map((record) => record.timestampMs));
    }
  }

  public lookup(query: TraceQuery): readonly RetainedChatTrace[] {
    this.prune();
    return [...this.traces.values()].filter((trace) => trace.guildId === query.guildId && trace.channelId === query.channelId &&
      (trace.sourceMessageId === query.sourceMessageId || trace.records.some((record) => "deliveredMessageId" in record.data && record.data.deliveredMessageId === query.sourceMessageId)))
      .map((trace) => ({ traceId: trace.traceId, processRunId: trace.processRunId, truncated: trace.truncated,
        records: trace.records.map((record) => structuredClone(record)) }));
  }

  public snapshot(): readonly RetainedChatTrace[] {
    this.prune();
    return [...this.traces.values()].map((trace) => ({ traceId: trace.traceId, processRunId: trace.processRunId,
      truncated: trace.truncated, records: trace.records.map((record) => structuredClone(record)) }));
  }

  public restoreTruncation(processRunId: string, traceId: string): void {
    for (const trace of this.traces.values()) if (trace.processRunId === processRunId && trace.traceId === traceId) trace.truncated = true;
  }

  public forgetGuild(guildId: string, beforeSequence: number): void {
    this.invalidateOldAppends(guildId, beforeSequence);
    for (const [key, trace] of this.traces) if (trace.guildId === guildId) this.remove(key, "privacy");
  }

  public excludeSource(query: TraceQuery, beforeSequence: number): void {
    const sourceKey = JSON.stringify([query.guildId, query.channelId, query.sourceMessageId]);
    this.sourceCutoffs.set(sourceKey, Math.max(beforeSequence, this.sourceCutoffs.get(sourceKey) ?? -1));
    for (const [key, trace] of this.traces) {
      if (trace.guildId !== query.guildId || trace.channelId !== query.channelId) continue;
      if (trace.sourceMessageId === query.sourceMessageId || trace.records.some((record) =>
        "sourceMessageId" in record.data && record.data.sourceMessageId === query.sourceMessageId ||
        "deliveredMessageId" in record.data && record.data.deliveredMessageId === query.sourceMessageId)) {
        if (trace.processRunId === diagnosticProcessRunId) for (const record of trace.records) this.excludedSequences.add(record.scope.traceSequence);
        this.remove(key, "privacy");
      }
    }
    if (this.sourceCutoffs.size > this.limits.maxTraces || this.excludedSequences.size > this.limits.maxTraces * 2) {
      this.globalCutoff = Math.max(this.globalCutoff, beforeSequence); this.sourceCutoffs.clear(); this.excludedSequences.clear();
    }
  }

  public status(): TraceStoreStatus {
    this.prune();
    return { traces: this.traces.size, events: this.events, bytes: this.bytes,
      droppedTraces: this.droppedTraces, droppedEvents: this.droppedEvents,
      invalidRecords: this.invalidRecords, expiredTraces: this.expiredTraces, writeFailures: 0 };
  }

  private invalidateOldAppends(guildId: string, beforeSequence: number): void {
    this.guildCutoffs.set(guildId, Math.max(beforeSequence, this.guildCutoffs.get(guildId) ?? -1));
    if (this.guildCutoffs.size > 256) {
      this.globalCutoff = Math.max(this.globalCutoff, ...this.guildCutoffs.values()); this.guildCutoffs.clear();
    }
  }

  private remove(key: string, reason: "capacity" | "expired" | "privacy"): void {
    const trace = this.traces.get(key); if (!trace) return;
    this.traces.delete(key); this.events -= trace.records.length; this.bytes -= trace.bytes;
    if (reason === "capacity") { this.droppedTraces++; this.droppedEvents += trace.records.length; }
    if (reason === "expired") this.expiredTraces++;
  }
}
