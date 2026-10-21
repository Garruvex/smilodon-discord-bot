import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatScheduler, balancedChatLimits } from "../../src/application/chat/chat-scheduler.js";

afterEach(() => vi.useRealTimers());

describe("bounded channel scheduler", () => {
  it("replaces a queued optional job with the freshest candidate", async () => {
    const scheduler = new ChatScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = scheduler.run("g:c", false, balancedChatLimits, () => gate);
    const old = vi.fn(() => Promise.resolve("old")); const fresh = vi.fn(() => Promise.resolve("fresh"));
    const replaced = scheduler.run("g:c", true, balancedChatLimits, old);
    const replacement = scheduler.run("g:c", true, balancedChatLimits, fresh);
    expect(await replaced).toBeNull();
    release(); await first;
    expect(await replacement).toBe("fresh"); expect(old).not.toHaveBeenCalled();
  });
  it("isolates guild concurrency and optional admission without interrupting accepted tool rounds", async () => {
    const scheduler = new ChatScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const limits = { ...balancedChatLimits, concurrency: 1, optionalTurnsPerWindow: 1, evaluationCooldownMs: 0 };
    const slow = scheduler.run("a:image", false, limits, () => gate);
    expect(await scheduler.run("b:chat", false, limits, () => Promise.resolve("available"))).toBe("available");
    release(); await slow;
    expect(await scheduler.run("a:optional", true, limits, () => Promise.resolve("finished"))).toBe("finished");
    expect(await scheduler.run("a:optional", true, limits, () => Promise.resolve("extra"))).toBeNull();
    expect(await scheduler.run("a:direct", false, limits, () => Promise.resolve("direct"))).toBe("direct");
    expect(await scheduler.run("b:optional", true, limits, () => Promise.resolve("other guild"))).toBe("other guild");
  });
  it("serializes people in one channel while unrelated channels can run", async () => {
    const scheduler = new ChatScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const first = scheduler.run("channel", false, balancedChatLimits, async () => { calls.push("alice"); await gate; });
    const second = scheduler.run("channel", false, balancedChatLimits, () => { calls.push("bob"); return Promise.resolve(); });
    const other = scheduler.run("other", false, balancedChatLimits, () => { calls.push("other"); return Promise.resolve(); });
    await other;
    expect(calls).toEqual(["alice", "other"]);
    release(); await Promise.all([first, second]);
    expect(calls).toEqual(["alice", "other", "bob"]);
  });
  it("prioritizes distinct direct questions and discards expired optional work", async () => {
    let now = 0;
    const scheduler = new ChatScheduler(() => now, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const first = scheduler.run("c", false, balancedChatLimits, () => gate);
    const stale = scheduler.run("c", true, balancedChatLimits, () => { calls.push("optional"); return Promise.resolve(); }, 10);
    const direct = scheduler.run("c", false, balancedChatLimits, () => { calls.push("direct"); return Promise.resolve(); });
    now = 20; release();
    await Promise.all([first, direct, stale]);
    expect(calls).toEqual(["direct"]);
  });
  it("silent evaluations consume allowance but cooldown expiry never creates output", async () => {
    let now = 0;
    const scheduler = new ChatScheduler(() => now);
    const evaluate = vi.fn(() => Promise.resolve("silent"));
    await scheduler.run("c", true, balancedChatLimits, evaluate);
    await scheduler.run("c", true, balancedChatLimits, evaluate);
    expect(evaluate).toHaveBeenCalledOnce();
    now = 100_000;
    expect(evaluate).toHaveBeenCalledOnce();
    await scheduler.run("c", true, balancedChatLimits, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
  it("reserves text/reaction capacity atomically and releases failed sends", () => {
    const scheduler = new ChatScheduler(() => 0);
    const text = scheduler.reserveOutput("c", "text", balancedChatLimits, true)!;
    expect(scheduler.reserveOutput("c", "text", balancedChatLimits, true)).toBeNull();
    expect(scheduler.reserveOutput("c", "reaction", balancedChatLimits, true)).not.toBeNull();
    text(false);
    expect(scheduler.reserveOutput("c", "text", balancedChatLimits, true)).not.toBeNull();
    expect(scheduler.reserveOutput("c", "text", balancedChatLimits, false)).not.toBeNull();
  });
  it("cancels a buffered optional opportunity independently of other channels", async () => {
    vi.useFakeTimers(); const scheduler = new ChatScheduler(); const old = vi.fn(); const other = vi.fn();
    scheduler.bufferOpportunity("g:c", old); scheduler.bufferOpportunity("g:other", other);
    scheduler.cancelBufferedOpportunity("g:c"); await vi.advanceTimersByTimeAsync(10000);
    expect(old).not.toHaveBeenCalled(); expect(other).toHaveBeenCalledOnce(); scheduler.stop();
  });
  it("buffers one refreshed opportunity with a maximum wait and discards it on stop", async () => {
    vi.useFakeTimers();
    const scheduler = new ChatScheduler();
    const old = vi.fn(); const fresh = vi.fn();
    scheduler.bufferOpportunity("c", old);
    await vi.advanceTimersByTimeAsync(3_000);
    scheduler.bufferOpportunity("c", fresh);
    await vi.advanceTimersByTimeAsync(3_000);
    scheduler.bufferOpportunity("c", fresh);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(old).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledOnce();
    scheduler.bufferOpportunity("c", old); scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(old).not.toHaveBeenCalled();
  });
});
