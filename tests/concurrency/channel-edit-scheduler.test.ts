import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelEditScheduler } from "../../src/application/concurrency/channel-edit-scheduler.js";

describe("ChannelEditScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a write right away while the channel has budget", async () => {
    const scheduler = new ChannelEditScheduler();
    const slot = scheduler.register({ channelId: "c1", key: "a", priority: 0 });
    const write = vi.fn(() => Promise.resolve(true));

    await slot.schedule(write);

    expect(write).toHaveBeenCalledOnce();
  });

  it("holds edits past the budget until the window frees up", async () => {
    vi.useFakeTimers();
    const scheduler = new ChannelEditScheduler({ maxEdits: 2, windowMs: 5_000 });
    const slots = ["a", "b", "c"].map((key) => scheduler.register({ channelId: "c1", key, priority: 0 }));
    const ran: string[] = [];

    const done = slots.map((slot, index) => slot.schedule(() => {
      ran.push(["a", "b", "c"][index] ?? "");
      return Promise.resolve(true);
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toEqual(["a", "b"]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(ran).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toEqual(["a", "b", "c"]);
    await Promise.all(done);
  });

  it("doesn't count writes that had nothing to change", async () => {
    vi.useFakeTimers();
    const scheduler = new ChannelEditScheduler({ maxEdits: 1, windowMs: 5_000 });
    const slot = scheduler.register({ channelId: "c1", key: "a", priority: 0 });
    const unchanged = vi.fn(() => Promise.resolve(false));
    const edit = vi.fn(() => Promise.resolve(true));

    await slot.schedule(unchanged);
    await slot.schedule(unchanged);
    await slot.schedule(edit);

    expect(unchanged).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledOnce();
  });

  it("keeps channels independent", async () => {
    vi.useFakeTimers();
    const scheduler = new ChannelEditScheduler({ maxEdits: 1, windowMs: 5_000 });
    const one = scheduler.register({ channelId: "c1", key: "a", priority: 0 });
    const two = scheduler.register({ channelId: "c2", key: "b", priority: 0 });
    const write = vi.fn(() => Promise.resolve(true));

    await one.schedule(write);
    await two.schedule(write);

    expect(write).toHaveBeenCalledTimes(2);
  });

  it("runs the lowest priority number first among writes scheduled together", async () => {
    const scheduler = new ChannelEditScheduler();
    const ran: string[] = [];
    const slot = (key: string, priority: number): Promise<void> =>
      scheduler.register({ channelId: "c1", key, priority }).schedule(() => {
        ran.push(key);
        return Promise.resolve(true);
      });

    await Promise.all([slot("progress", 3), slot("lyrics", 1), slot("queue", 0)]);

    expect(ran).toEqual(["queue", "lyrics", "progress"]);
  });

  it("replaces a slot's pending write with its newest one, resolving both callers", async () => {
    vi.useFakeTimers();
    const scheduler = new ChannelEditScheduler({ maxEdits: 1, windowMs: 5_000 });
    const busy = scheduler.register({ channelId: "c1", key: "busy", priority: 0 });
    const slot = scheduler.register({ channelId: "c1", key: "a", priority: 1 });
    await busy.schedule(() => Promise.resolve(true));

    const stale = vi.fn(() => Promise.resolve(true));
    const latest = vi.fn(() => Promise.resolve(true));
    const first = slot.schedule(stale);
    const second = slot.schedule(latest);
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([first, second]);

    expect(stale).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });

  it("passes a failed write's error to its callers and keeps the channel going", async () => {
    const scheduler = new ChannelEditScheduler();
    const failing = scheduler.register({ channelId: "c1", key: "a", priority: 0 });
    const next = scheduler.register({ channelId: "c1", key: "b", priority: 1 });
    const after = vi.fn(() => Promise.resolve(true));

    const failed = failing.schedule(() => Promise.reject(new Error("boom")));
    const ok = next.schedule(after);

    await expect(failed).rejects.toThrow("boom");
    await ok;
    expect(after).toHaveBeenCalledOnce();
  });

  it("drops a pending write on unregister and frees the key", async () => {
    vi.useFakeTimers();
    const scheduler = new ChannelEditScheduler({ maxEdits: 1, windowMs: 5_000 });
    const busy = scheduler.register({ channelId: "c1", key: "busy", priority: 0 });
    await busy.schedule(() => Promise.resolve(true));
    const slot = scheduler.register({ channelId: "c1", key: "a", priority: 0 });
    const write = vi.fn(() => Promise.resolve(true));

    const pending = slot.schedule(write);
    slot.unregister();
    await pending;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(write).not.toHaveBeenCalled();
    expect(() => scheduler.register({ channelId: "c1", key: "a", priority: 0 })).not.toThrow();
  });

  it("rejects registering the same key twice", () => {
    const scheduler = new ChannelEditScheduler();
    scheduler.register({ channelId: "c1", key: "a", priority: 0 });
    expect(() => scheduler.register({ channelId: "c2", key: "a", priority: 0 })).toThrow(/already registered/);
  });
});
