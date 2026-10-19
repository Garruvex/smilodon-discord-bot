import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileChatTraceStore } from "../../src/infrastructure/persistence/file-chat-trace-store.js";
import { attachDiagnosticStore, currentDiagnosticTraceSequence, emitChatDiagnostic, withDiagnosticScope } from "../../src/application/diagnostics/chat-diagnostics.js";
import { diagnosticRecord } from "../helpers/chat-trace-fixtures.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

const stores: FileChatTraceStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "chat-trace-")); directories.push(result); return result;
}
const query = { guildId: "guild", channelId: "channel", sourceMessageId: "source" };

describe("diagnostic snapshot persistence", () => {
  it("persists a single interruption marker when a prior process lacks a terminal event", async () => {
    const root = await directory(); const store = new FileChatTraceStore(root, null, {}, () => 1000); stores.push(store); await store.initialize();
    store.record(diagnosticRecord({ processRunId: "previous-process" })); await store.close();
    const restored = new FileChatTraceStore(root, null, {}, () => 1100); stores.push(restored); await restored.initialize();
    expect(restored.lookup(query)[0]?.records.at(-1)?.data).toMatchObject({ event: "chat.trace.interrupted", unfinishedSpans: 1 });
    await restored.close();
    const again = new FileChatTraceStore(root, null, {}, () => 1200); stores.push(again); await again.initialize();
    expect(again.lookup(query)[0]?.records.filter((record) => record.data.event === "chat.trace.interrupted")).toHaveLength(1);
  });
  it("finishes a snapshot without chasing a continuously changing event stream", async () => {
    class BusyStore extends FileChatTraceStore {
      public writes = 0;
      public growing = true;
      protected override async persist(body: string): Promise<void> {
        this.writes++;
        if (this.growing && this.writes < 5) this.record(diagnosticRecord({ eventSequence: this.writes + 1 }));
        await super.persist(body);
      }
    }
    const store = new BusyStore(await directory(), null, {}, () => 1000); stores.push(store); await store.initialize();
    store.record(diagnosticRecord()); await store.flush();
    expect(store.writes).toBe(1);
    expect(store.status().events).toBe(2);
    store.growing = false; await store.flush(); expect(store.writes).toBe(2);
  });
  it("inherits a per-instance store through child loggers, independently of log level", async () => {
    const root = await directory();
    const store = new FileChatTraceStore(root); stores.push(store); await store.initialize();
    const { logger } = captureDiagnosticLogger();
    attachDiagnosticStore(logger, store);
    const child = logger.child({ component: "test" }); child.level = "silent";
    withDiagnosticScope({ operation: "chat_turn", ...query }, () => emitChatDiagnostic(child, { event: "chat.turn.started", triggerMode: "direct" }));
    expect(store.lookup(query)[0]?.records).toHaveLength(1);
    await store.flush();
    await store.close();
    const restored = new FileChatTraceStore(root); stores.push(restored); await restored.initialize();
    expect(restored.lookup(query)[0]?.records[0]?.data).toEqual({ event: "chat.turn.started", triggerMode: "direct" });
    await restored.flush();
    expect(await readFile(join(root, "chat-diagnostics", "traces.json"), "utf8")).not.toContain("prompt");
  });

  it("does not broadcast diagnostics between distinct instance loggers", async () => {
    const first = new FileChatTraceStore(await directory()); const second = new FileChatTraceStore(await directory());
    stores.push(first, second); await Promise.all([first.initialize(), second.initialize()]);
    const a = captureDiagnosticLogger().logger; const b = captureDiagnosticLogger().logger;
    attachDiagnosticStore(a, first); attachDiagnosticStore(b, second);
    withDiagnosticScope({ operation: "dispatch", ...query }, () => emitChatDiagnostic(a, { event: "chat.ingress.received", kind: "message_created" }));
    expect(first.lookup(query)).toHaveLength(1); expect(second.lookup(query)).toEqual([]);
  });

  it("durably forgets a guild and blocks late events from an already running scope", async () => {
    const root = await directory(); const store = new FileChatTraceStore(root); stores.push(store); await store.initialize();
    const { logger } = captureDiagnosticLogger(); attachDiagnosticStore(logger, store);
    await withDiagnosticScope({ operation: "chat_turn", ...query }, async () => {
      emitChatDiagnostic(logger, { event: "chat.turn.started", triggerMode: "direct" });
      await store.forgetGuild("guild", currentDiagnosticTraceSequence());
      emitChatDiagnostic(logger, { event: "chat.turn.completed", triggerMode: "direct", outcome: "no_text_delivery", durationMs: 1, textDeliveryConfirmed: false });
    });
    expect(store.lookup(query)).toEqual([]); await store.flush();
    expect(await readFile(join(root, "chat-diagnostics", "traces.json"), "utf8")).not.toContain('"source"');
  });

  it("prunes expired records on restart and survives malformed snapshots without logging their content", async () => {
    let now = 1000; const root = await directory();
    const store = new FileChatTraceStore(root, null, { retentionMs: 1000 }, () => now); stores.push(store); await store.initialize();
    store.record(diagnosticRecord()); await store.close(); now = 2000;
    const restored = new FileChatTraceStore(root, null, { retentionMs: 1000 }, () => now); stores.push(restored); await restored.initialize();
    expect(restored.lookup(query)).toEqual([]); await restored.close();
    await writeFile(join(root, "chat-diagnostics", "traces.json"), "SECRET_INVALID_JSON", "utf8");
    const { logger, records } = captureDiagnosticLogger();
    const corrupt = new FileChatTraceStore(root, logger); stores.push(corrupt); await corrupt.initialize(); await corrupt.flush();
    expect(corrupt.lookup(query)).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ event: "diagnostics.pipeline.degraded", reason: "restore_failed", failure: "invalid_json" })]);
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });

  it("retains drop/truncation information in a bounded snapshot", async () => {
    const root = await directory();
    const store = new FileChatTraceStore(root, null, { maxEventsPerTrace: 1 }, () => 1000); stores.push(store); await store.initialize();
    store.record(diagnosticRecord()); store.record(diagnosticRecord({ eventSequence: 2 })); await store.close();
    const restored = new FileChatTraceStore(root, null, { maxEventsPerTrace: 1 }, () => 1000); stores.push(restored); await restored.initialize();
    expect(restored.lookup(query)[0]).toMatchObject({ truncated: true });
    expect(restored.lookup(query)[0]?.records).toHaveLength(1);
  });

  it("does not let an older in-flight snapshot restore data after a forget finishes", async () => {
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { started = resolve; });
    class DelayedStore extends FileChatTraceStore {
      private delayed = false;
      protected override async persist(body: string): Promise<void> {
        if (!this.delayed) { this.delayed = true; started(); await gate; }
        await super.persist(body);
      }
    }
    const root = await directory(); const store = new DelayedStore(root, null, {}, () => 1000); stores.push(store); await store.initialize();
    store.record(diagnosticRecord());
    const oldWrite = store.flush(); await writing;
    const forgetting = store.forgetGuild("guild", 1);
    store.record(diagnosticRecord({ eventSequence: 2 }));
    release(); await Promise.all([oldWrite, forgetting]);
    expect(store.lookup(query)).toEqual([]);
    expect(await readFile(join(root, "chat-diagnostics", "traces.json"), "utf8")).not.toContain('"source"');
  });

  it("keeps memory available on disk failure and can retry without dumping exceptions", async () => {
    class FailingStore extends FileChatTraceStore {
      private failed = false;
      protected override persist(body: string): Promise<void> {
        if (!this.failed) { this.failed = true; return Promise.reject(new Error("SECRET_PATH_AND_TOKEN")); }
        return super.persist(body);
      }
    }
    const { logger, records } = captureDiagnosticLogger();
    const store = new FailingStore(await directory(), logger, {}, () => 1000); stores.push(store); await store.initialize();
    store.record(diagnosticRecord());
    await expect(store.flush()).rejects.toThrow("SECRET_PATH_AND_TOKEN");
    expect(store.lookup(query)).toHaveLength(1); expect(store.status().writeFailures).toBe(1);
    expect(JSON.stringify(records)).not.toContain("SECRET");
    await store.flush();
  });
});
