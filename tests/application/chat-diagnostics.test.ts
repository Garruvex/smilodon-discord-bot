import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { attachDiagnosticStore, bindDiagnosticTask, diagnosticFields, emitChatDiagnostic, safeFailure, withDiagnosticScope } from "../../src/application/diagnostics/chat-diagnostics.js";
import { MemoryChatTraceStore } from "../helpers/chat-trace-fixtures.js";
import { ChatScheduler, balancedChatLimits } from "../../src/application/chat/chat-scheduler.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

describe("chat diagnostic boundary", () => {
  it("continues operational logging when diagnostic retention itself fails", () => {
    const { logger, records } = captureDiagnosticLogger();
    const store = new MemoryChatTraceStore();
    vi.spyOn(store, "record").mockImplementation(() => { throw new Error("SECRET_RETENTION_FAILURE"); });
    attachDiagnosticStore(logger, store);
    withDiagnosticScope({ operation: "chat_turn", guildId: "guild", channelId: "channel", sourceMessageId: "source" }, () => {
      emitChatDiagnostic(logger, { event: "chat.turn.started", triggerMode: "direct" });
    });
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });
  it("strips arbitrary runtime fields and emits no raw error content", () => {
    const { logger, records } = captureDiagnosticLogger();
    const error = Object.assign(new Error("SECRET_PROVIDER_BODY"), { status: 429, token: "SECRET_TOKEN", cause: { prompt: "SECRET_PROMPT" } });
    const unsafe = { event: "chat.model.completed" as const, purpose: "reply" as const, status: "failed" as const,
      durationMs: 1, ...safeFailure(error), error, response: "SECRET_RESPONSE", prompt: "SECRET_PROMPT" };
    emitChatDiagnostic(logger, unsafe);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ schemaVersion: 1, event: "chat.model.completed", failure: "rate_limited", httpStatus: 429 });
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });

  it("classifies safe structural failures without exception messages or provider codes", () => {
    expect(safeFailure(new DOMException("SECRET_TIMEOUT", "TimeoutError"))).toEqual({ failure: "timeout" });
    expect(safeFailure(new SyntaxError("SECRET_JSON"))).toEqual({ failure: "invalid_json" });
    expect(safeFailure(new z.ZodError([]))).toEqual({ failure: "schema_mismatch" });
    expect(safeFailure({ code: "incomplete_response" })).toEqual({ failure: "incomplete_response" });
    expect(safeFailure({ code: "SECRET_CUSTOM_CODE", name: "SECRET_ERROR_TYPE" })).toEqual({ failure: "provider_error" });
  });

  it("shares trace IDs across child spans and isolates concurrent roots", async () => {
    const { logger, records } = captureDiagnosticLogger();
    await Promise.all(["a", "b"].map((sourceMessageId) => withDiagnosticScope({ operation: "dispatch", sourceMessageId }, async () => {
      emitChatDiagnostic(logger, { event: "chat.ingress.received", kind: "message_created" });
      await Promise.resolve();
      withDiagnosticScope({ operation: "chat_turn", sourceMessageId }, () => emitChatDiagnostic(logger, { event: "chat.turn.started", triggerMode: "direct" }));
    })));
    for (const id of ["a", "b"]) {
      const [ingress, turn] = records.filter((record) => record.sourceMessageId === id);
      expect(turn?.traceId).toBe(ingress?.traceId);
      expect(turn?.parentSpanId).toBe(ingress?.spanId);
      expect(turn?.spanId).not.toBe(ingress?.spanId);
    }
    expect(records.find((record) => record.sourceMessageId === "a")?.traceId).not.toBe(records.find((record) => record.sourceMessageId === "b")?.traceId);
    expect(diagnosticFields()).toEqual({});
  });

  it("restores the submitting trace when another request pumps a queued task", async () => {
    const scheduler = new ChatScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: unknown[] = [];
    const first = withDiagnosticScope({ operation: "chat_turn", sourceMessageId: "a" }, () => scheduler.run("guild:channel", false, balancedChatLimits, async () => {
      seen.push(diagnosticFields().sourceMessageId);
      await gate;
    }));
    const second = withDiagnosticScope({ operation: "chat_turn", sourceMessageId: "b" }, () => scheduler.run("guild:channel", false, balancedChatLimits, () => {
      seen.push(diagnosticFields().sourceMessageId);
      return Promise.resolve();
    }));
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual(["a", "b"]);
    scheduler.stop();
  });

  it("does not inherit a worker trace for an untraced task", () => {
    const task = bindDiagnosticTask(() => diagnosticFields());
    expect(withDiagnosticScope({ operation: "dispatch", sourceMessageId: "worker" }, task)).toEqual({});
  });

  it("does not let a failed telemetry sink interrupt processing", () => {
    const { logger } = captureDiagnosticLogger();
    vi.spyOn(logger, "info").mockImplementation(() => { throw new Error("sink failed"); });
    expect(() => emitChatDiagnostic(logger, { event: "chat.turn.started", triggerMode: "direct" })).not.toThrow();
  });
});
