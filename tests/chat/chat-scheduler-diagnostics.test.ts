import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatScheduler, balancedChatLimits } from "../../src/application/chat/chat-scheduler.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { withDiagnosticScope } from "../../src/application/diagnostics/chat-diagnostics.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

afterEach(() => vi.useRealTimers());

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function inTurn<T>(sourceMessageId: string, operation: () => T): T {
  return withDiagnosticScope({ operation: "chat_turn", sourceMessageId }, operation);
}

function terminalQueueEvents(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.filter((record) => record.event === "chat.queue.changed" && record.action !== "enqueued" && record.action !== "admitted");
}

describe("scheduler diagnostic outcomes", () => {
  it("keeps replacement diagnostics on the replaced job's trace", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(() => 0, 1, 12, 256, logger);
    const blocked = gate();
    const first = inTurn("first", () => scheduler.run("g:c", false, balancedChatLimits, () => blocked.promise));
    const oldOperation = vi.fn(() => Promise.resolve("old"));
    const old = inTurn("old", () => scheduler.run("g:c", true, balancedChatLimits, oldOperation));
    const fresh = inTurn("fresh", () => scheduler.run("g:c", true, balancedChatLimits, () => Promise.resolve("fresh")));
    expect(await old).toBeNull();
    blocked.release(); await Promise.all([first, fresh]);
    expect(oldOperation).not.toHaveBeenCalled();
    const replaced = terminalQueueEvents(records).filter((record) => record.sourceMessageId === "old");
    expect(replaced).toEqual([expect.objectContaining({ action: "cancelled", reason: "replaced_by_optional" })]);
    expect(replaced[0]?.traceId).toBe(records.find((record) => record.sourceMessageId === "old" && record.action === "enqueued")?.traceId);
    expect(replaced[0]?.traceId).not.toBe(records.find((record) => record.sourceMessageId === "fresh")?.traceId);
    scheduler.stop();
  });

  it("records direct-request preemption and distinguishes it from queue rejection", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(() => 0, 1, 1, 256, logger);
    const blocked = gate();
    const first = scheduler.run("g:c", false, balancedChatLimits, () => blocked.promise);
    const old = inTurn("old", () => scheduler.run("g:c", true, balancedChatLimits, () => Promise.resolve("old")));
    const direct = inTurn("direct", () => scheduler.run("g:c", false, balancedChatLimits, () => Promise.resolve("direct")));
    expect(await old).toBeNull();
    expect(await inTurn("overflow", () => scheduler.run("g:c", true, balancedChatLimits, () => Promise.resolve("unexpected")))).toBeNull();
    await expect(inTurn("direct-overflow", () => scheduler.run("g:c", false, balancedChatLimits, () => Promise.resolve("unexpected")))).rejects.toThrow("queue is full");
    blocked.release(); await Promise.all([first, direct]);
    expect(terminalQueueEvents(records)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceMessageId: "old", action: "cancelled", reason: "preempted_by_direct" }),
      expect.objectContaining({ sourceMessageId: "overflow", action: "skipped", reason: "channel_queue_full" }),
      expect.objectContaining({ sourceMessageId: "direct-overflow", reason: "channel_queue_full" }),
    ]));
    scheduler.stop();
  });

  it("reports global queue capacity without exposing internal queue keys", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(() => 0, 1, 12, 1, logger);
    const blocked = gate();
    const first = scheduler.run("SECRET_GUILD:running", false, balancedChatLimits, () => blocked.promise);
    const waiting = scheduler.run("SECRET_GUILD:waiting", false, balancedChatLimits, () => Promise.resolve("waiting"));
    expect(await scheduler.run("SECRET_GUILD:extra", true, balancedChatLimits, () => Promise.resolve("unexpected"))).toBeNull();
    blocked.release(); await Promise.all([first, waiting]);
    expect(terminalQueueEvents(records)).toEqual(expect.arrayContaining([expect.objectContaining({ action: "skipped", reason: "global_queue_full" })]));
    expect(JSON.stringify(records)).not.toContain("SECRET");
    scheduler.stop();
  });

  it("reports expiry and queue wait once without executing stale work", async () => {
    let now = 0;
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(() => now, 1, 12, 256, logger);
    const blocked = gate();
    const first = scheduler.run("g:c", false, balancedChatLimits, () => blocked.promise);
    const operation = vi.fn(() => Promise.resolve("unexpected"));
    const stale = inTurn("stale", () => scheduler.run("g:c", true, balancedChatLimits, operation, 10));
    now = 20; blocked.release();
    await Promise.all([first, stale]);
    expect(operation).not.toHaveBeenCalled();
    expect(terminalQueueEvents(records).filter((record) => record.sourceMessageId === "stale")).toEqual([
      expect.objectContaining({ action: "cancelled", reason: "expired", waitMs: 20 }),
    ]);
    scheduler.stop();
  });

  it("separates evaluation cooldown from budget exhaustion and records no false completion", async () => {
    let now = 0;
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(() => now, 1, 12, 256, logger);
    const limits = { ...balancedChatLimits, evaluationCooldownMs: 100, optionalTurnsPerWindow: 1 };
    const operation = vi.fn(() => Promise.resolve("silent"));
    await scheduler.run("g:c", true, limits, operation);
    await scheduler.run("g:c", true, limits, operation);
    now = 101;
    await scheduler.run("g:c", true, limits, operation);
    expect(operation).toHaveBeenCalledOnce();
    expect(terminalQueueEvents(records).map((record) => record.reason)).toEqual(["executed", "evaluation_cooldown", "evaluation_budget"]);
    expect(new Set(terminalQueueEvents(records).map((record) => record.jobId)).size).toBe(3);
    scheduler.stop();
  });

  it("records shutdown on pending work, retaining original traces and promise behavior", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(() => 0, 1, 12, 256, logger);
    const blocked = gate();
    const first = scheduler.run("g:c", false, balancedChatLimits, () => blocked.promise);
    const waiting = inTurn("waiting", () => scheduler.run("g:c", false, balancedChatLimits, () => Promise.resolve()));
    const rejected = expect(waiting).rejects.toBeInstanceOf(SocialOutputSuppressed);
    scheduler.stop();
    await rejected;
    blocked.release(); await first;
    expect(terminalQueueEvents(records).filter((record) => record.sourceMessageId === "waiting")).toEqual([
      expect.objectContaining({ action: "cancelled", reason: "shutdown" }),
    ]);
    await expect(scheduler.run("g:c", false, balancedChatLimits, () => Promise.resolve())).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(terminalQueueEvents(records).at(-1)).toMatchObject({ reason: "scheduler_closed" });
  });

  it("distinguishes operation suppression from failure without logging exception content", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(() => 0, 1, 12, 256, logger);
    await expect(scheduler.run("g:c", false, balancedChatLimits, () => Promise.reject(new SocialOutputSuppressed()))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    await expect(scheduler.run("g:c", false, balancedChatLimits, () => Promise.reject(new Error("SECRET_ERROR_BODY")))).rejects.toThrow("SECRET_ERROR_BODY");
    expect(terminalQueueEvents(records)).toEqual([
      expect.objectContaining({ action: "cancelled", reason: "operation_suppressed" }),
      expect.objectContaining({ action: "failed", reason: "operation_failed", failure: "operation_error" }),
    ]);
    expect(JSON.stringify(records)).not.toContain("SECRET");
    scheduler.stop();
  });

  it("attributes buffered coalescing and cancellation to the original opportunity", async () => {
    vi.useFakeTimers();
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(Date.now, 1, 12, 256, logger);
    const operation = vi.fn();
    inTurn("old", () => scheduler.bufferOpportunity("g:c", operation));
    await vi.advanceTimersByTimeAsync(3000);
    inTurn("fresh", () => scheduler.bufferOpportunity("g:c", operation));
    inTurn("other", () => scheduler.cancelBufferedOpportunity("g:c", "addressed_request"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(operation).not.toHaveBeenCalled();
    const events = records.filter((record) => record.event === "chat.opportunity.changed");
    expect(events.map((record) => [record.sourceMessageId, record.action, record.reason])).toEqual([
      ["old", "buffered", "coalescing"], ["old", "cancelled", "superseded"],
      ["fresh", "coalesced", "coalescing"], ["fresh", "cancelled", "addressed_request"],
    ]);
    expect(events[2]?.previousOpportunityId).toBe(events[0]?.opportunityId);
    scheduler.stop();
  });

  it("reports buffered flushes, capacity rejection, and shutdown without starting extra work", async () => {
    vi.useFakeTimers();
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(Date.now, 1, 12, 1, logger);
    const executed = vi.fn();
    scheduler.bufferOpportunity("g:c", executed);
    scheduler.bufferOpportunity("g:extra", vi.fn());
    await vi.advanceTimersByTimeAsync(4000);
    expect(executed).toHaveBeenCalledOnce();
    scheduler.bufferOpportunity("g:c", vi.fn()); scheduler.stop();
    scheduler.bufferOpportunity("g:c", vi.fn());
    expect(records.filter((record) => record.event === "chat.opportunity.changed" && record.action !== "buffered").map((record) => record.reason)).toEqual([
      "capacity", "ready", "shutdown", "scheduler_closed",
    ]);
  });

  it("records atomic reservations and idempotent release using the reserving trace", () => {
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(() => 0, 1, 12, 256, logger);
    const limits = { ...balancedChatLimits, textPerWindow: 1 };
    const failed = inTurn("owner", () => scheduler.reserveOutput("g:c", "text", limits, true))!;
    expect(inTurn("other", () => scheduler.reserveOutput("g:c", "text", limits, true))).toBeNull();
    inTurn("other", () => { failed(false); failed(true); });
    const retry = scheduler.reserveOutput("g:c", "text", limits, true)!;
    retry(true); retry(true);
    expect(scheduler.reserveOutput("g:c", "text", limits, true)).toBeNull();
    const events = records.filter((record) => record.event === "chat.output.reservation");
    expect(events.map((record) => record.reason)).toEqual(["available", "in_flight", "not_delivered", "available", "delivered", "channel_limit"]);
    expect(events[2]).toMatchObject({ sourceMessageId: "owner", reservationId: events[0]?.reservationId, status: "released" });
    scheduler.stop();
  });

  it("distinguishes continuation interval, per-exchange limit, and aggregate channel limit", () => {
    let now = 0;
    const { logger, records } = captureDiagnosticLogger();
    const scheduler = new ChatScheduler(() => now, 1, 12, 256, logger);
    const base = { ...balancedChatLimits, continuation: true, continuationPerExchange: 1, continuationPerWindow: 2, exchangeId: "a" };
    scheduler.reserveOutput("g:c", "text", base, true)!(true);
    expect(scheduler.reserveOutput("g:c", "text", base, true)).toBeNull();
    expect(scheduler.reserveOutput("g:c", "text", { ...base, exchangeId: "b" }, true)).toBeNull();
    now = 15_000;
    scheduler.reserveOutput("g:c", "text", { ...base, exchangeId: "b" }, true)!(true);
    expect(scheduler.reserveOutput("g:c", "text", { ...base, exchangeId: "c" }, true)).toBeNull();
    expect(records.filter((record) => record.status === "denied").map((record) => record.reason)).toEqual(["exchange_limit", "cooldown", "channel_limit"]);
    scheduler.stop();
  });
});
