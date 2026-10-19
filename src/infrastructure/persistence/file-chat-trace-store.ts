import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { BoundedChatTraceBuffer, type ChatTraceStore, type RetainedChatTrace, type TraceQuery, type TraceStoreLimits, type TraceStoreStatus } from "../../application/diagnostics/chat-trace-store.js";
import { chatDiagnosticRecordSchema, safeFailure, type ChatDiagnosticRecord, type DiagnosticLogger } from "../../application/diagnostics/chat-diagnostics.js";

// One bounded snapshot per bot instance. Appends stay in memory; at most one
// disk write is in flight and one debounce timer is queued.
export class FileChatTraceStore implements ChatTraceStore {
  private readonly buffer: BoundedChatTraceBuffer;
  private readonly directory: string;
  private readonly file: string;
  private revision = 0;
  private persistedRevision = -1;
  private writing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private writeFailures = 0;
  private failureStreak = 0;
  private lastWarningAt = -Infinity;

  public constructor(runtimeDirectory: string, private readonly logger: DiagnosticLogger | null = null,
    limits: Partial<TraceStoreLimits> = {}, private readonly now: () => number = Date.now) {
    this.directory = resolve(runtimeDirectory, "chat-diagnostics");
    this.file = resolve(this.directory, "traces.json");
    this.buffer = new BoundedChatTraceBuffer(limits, now);
  }

  public async initialize(): Promise<void> {
    try {
      const maximumSnapshotBytes = this.buffer.limits.maxBytes + this.buffer.limits.maxEvents + this.buffer.limits.maxTraces * 512 + 1024;
      const file = await stat(this.file);
      if (file.size > maximumSnapshotBytes) throw new Error("Diagnostic snapshot exceeds limit");
      const body = await readFile(this.file, "utf8");
      if (Buffer.byteLength(body, "utf8") > maximumSnapshotBytes) throw new Error("Diagnostic snapshot exceeds limit");
      const schema = z.object({ schemaVersion: z.literal(1), traces: z.array(z.object({
        traceId: z.string().max(128), processRunId: z.string().max(128), truncated: z.boolean(),
        records: z.array(chatDiagnosticRecordSchema).max(this.buffer.limits.maxEventsPerTrace),
      })).max(this.buffer.limits.maxTraces) });
      const snapshot = schema.parse(JSON.parse(body));
      for (const trace of snapshot.traces) {
        for (const record of trace.records) this.buffer.record(record);
        if (trace.truncated) this.buffer.restoreTruncation(trace.processRunId, trace.traceId);
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) this.warn("restore_failed", error);
    }
    // Rewrite the sanitized/pruned snapshot, including after a corrupt restore.
    this.revision++;
    this.schedule();
    this.cleanupTimer = setInterval(() => { this.buffer.prune(); this.revision++; this.schedule(); }, 60_000);
    this.cleanupTimer.unref?.();
  }

  public record(record: ChatDiagnosticRecord): void {
    if (this.closed) return;
    if (this.buffer.record(record)) { this.revision++; this.schedule(); }
  }
  public lookup(query: TraceQuery): readonly RetainedChatTrace[] { return this.buffer.lookup(query); }
  public status(): TraceStoreStatus { return { ...this.buffer.status(), writeFailures: this.writeFailures }; }

  public async forgetGuild(guildId: string, beforeSequence: number): Promise<void> {
    this.buffer.forgetGuild(guildId, beforeSequence); this.revision++;
    // Wait through any older in-flight snapshot, then durably replace it.
    await this.flush();
  }

  public excludeSource(query: TraceQuery, beforeSequence: number): void {
    this.buffer.excludeSource(query, beforeSequence); this.revision++; this.schedule();
  }

  public async flush(): Promise<void> {
    // Cover this caller's revision, rather than chasing an ever-moving head.
    // New events arriving during I/O are handled by the next debounce window.
    const requiredRevision = this.revision;
    while (this.persistedRevision < requiredRevision) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.writing) { await this.writing; continue; }
      const version = this.revision;
      const snapshot = JSON.stringify({ schemaVersion: 1, traces: this.buffer.snapshot() });
      this.writing = this.persist(snapshot).then(() => {
        this.persistedRevision = version; this.failureStreak = 0;
      }, (error: unknown) => {
        this.writeFailures++; this.failureStreak++; this.warn("persistence_failed", error); throw error;
      }).finally(() => {
        this.writing = null;
        if (!this.closed && this.persistedRevision !== this.revision) this.schedule();
      });
      await this.writing;
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    await this.flush();
  }

  private schedule(): void {
    if (this.closed || this.timer || this.writing) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.failureStreak, 6));
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, delay);
    this.timer.unref?.();
  }

  protected async persist(body: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = resolve(this.directory, `traces.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined); throw error;
    }
  }

  private warn(reason: "restore_failed" | "persistence_failed", error: unknown): void {
    if (this.now() - this.lastWarningAt < 60_000) return;
    this.lastWarningAt = this.now();
    try { this.logger?.warn({ event: "diagnostics.pipeline.degraded", reason, ...safeFailure(error, "operation_error"), writeFailures: this.writeFailures }, "Diagnostic retention is degraded"); }
    catch { /* A failed log sink must not stop the bot or bypass authorization. */ }
  }
}
