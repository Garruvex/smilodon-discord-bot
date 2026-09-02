import { describe, expect, it } from "vitest";

import { KeyedSerialQueue } from "../../src/application/concurrency/keyed-serial-queue.js";

describe("KeyedSerialQueue", () => {
  it("runs tasks for the same key strictly in submission order, even when an earlier task is slower", async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.run("guild", async () => {
      await firstGate;
      order.push("first");
    });
    // Submitted while the first task is still in flight — this is the exact
    // shape of the race the queue exists to prevent: a slow, already-running
    // write must not be overtaken by one submitted after it.
    const second = queue.run("guild", () => {
      order.push("second");
      return Promise.resolve();
    });

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first", "second"]);
  });

  it("lets different keys run fully concurrently", async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });

    const taskA = queue.run("guild-a", async () => {
      await gateA;
      order.push("a");
    });
    const taskB = queue.run("guild-b", () => {
      order.push("b");
      return Promise.resolve();
    });

    // guild-b's task isn't blocked behind guild-a's still-pending gate.
    await taskB;
    expect(order).toEqual(["b"]);

    releaseA();
    await taskA;
    expect(order).toEqual(["b", "a"]);
  });

  it("propagates a task's own rejection without blocking the next queued task", async () => {
    const queue = new KeyedSerialQueue();

    const failing = queue.run("guild", () => Promise.reject(new Error("boom")));
    const next = queue.run("guild", () => Promise.resolve("ok"));

    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("reports isBusy while a task is running or queued behind one, and clears once idle", async () => {
    const queue = new KeyedSerialQueue();
    expect(queue.isBusy("guild")).toBe(false);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = queue.run("guild", async () => {
      await gate;
    });

    expect(queue.isBusy("guild")).toBe(true);
    release();
    await task;
    expect(queue.isBusy("guild")).toBe(false);
  });
});
