import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PanelRefreshCoordinator } from "../../src/application/control-panel/panel-refresh-coordinator.js";

const debounceMs = 50;
const maxWaitMs = 200;

function createCoordinator(
  refresh: (guildId: string, options: { forceIdleImage?: boolean }) => Promise<void>,
): PanelRefreshCoordinator {
  return new PanelRefreshCoordinator(refresh, debounceMs, maxWaitMs);
}

describe("PanelRefreshCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses ten same-tick requests into one edit", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createCoordinator(refresh);

    const requests = Array.from({ length: 10 }, () => coordinator.request("guild"));
    await vi.advanceTimersByTimeAsync(debounceMs);
    await Promise.all(requests);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces trackStart + queueChanged + a handler-finally refresh into one edit", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createCoordinator(refresh);

    const trackStart = coordinator.request("guild");
    const queueChanged = coordinator.request("guild");
    const handlerFinally = coordinator.request("guild");
    await vi.advanceTimersByTimeAsync(debounceMs);
    await Promise.all([trackStart, queueChanged, handlerFinally]);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("produces exactly one trailing edit for a request that arrives during an active edit", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let state = "old";
    const rendered: string[] = [];
    const refresh = vi.fn(async (): Promise<void> => {
      const captured = state;
      if (rendered.length === 0) await firstGate;
      rendered.push(captured);
    });
    const coordinator = createCoordinator(refresh);

    const oldRefresh = coordinator.request("guild");
    await vi.advanceTimersByTimeAsync(debounceMs);
    expect(refresh).toHaveBeenCalledOnce();

    state = "latest";
    const latestRefresh = coordinator.request("guild");
    releaseFirst();
    await vi.advanceTimersByTimeAsync(debounceMs);
    await Promise.all([oldRefresh, latestRefresh]);

    expect(rendered).toEqual(["old", "latest"]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("respects the maximum wait under sustained requests", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createCoordinator(refresh);

    const requests = [coordinator.request("guild")];
    // Each request resets the debounce window before it can fire.
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(debounceMs - 10);
      requests.push(coordinator.request("guild"));
    }
    expect(refresh).not.toHaveBeenCalled();

    // Once total elapsed time reaches maxWaitMs the batch must fire anyway,
    // even though requests kept resetting the debounce window.
    await vi.advanceTimersByTimeAsync(maxWaitMs);
    await Promise.all(requests);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("resolves earlier waiters once their own batch renders, without waiting on a later trailing batch", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const refresh = vi.fn()
      .mockImplementationOnce(() => firstGate)
      .mockResolvedValue(undefined);
    const coordinator = createCoordinator(refresh);

    const first = coordinator.request("guild");
    await vi.advanceTimersByTimeAsync(debounceMs);
    expect(refresh).toHaveBeenCalledOnce();

    const second = coordinator.request("guild");

    releaseFirst();
    // If `first` were only resolved after the whole burst settles (the old
    // serializer's behavior), this would hang forever: the second batch's
    // timer never advances in this assertion.
    await first;
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(debounceMs);
    await second;
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("merges forceIdleImage across a coalesced batch", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createCoordinator(refresh);

    const requests = [
      coordinator.request("guild"),
      coordinator.request("guild", { forceIdleImage: true }),
      coordinator.request("guild"),
    ];
    await vi.advanceTimersByTimeAsync(debounceMs);
    await Promise.all(requests);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("guild", { forceIdleImage: true });
  });

  it("keeps different guilds independent", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createCoordinator(refresh);

    const requests = [
      coordinator.request("guild-a"),
      coordinator.request("guild-b"),
    ];
    await vi.advanceTimersByTimeAsync(debounceMs);
    await Promise.all(requests);

    expect(refresh).toHaveBeenCalledWith("guild-a", { forceIdleImage: false });
    expect(refresh).toHaveBeenCalledWith("guild-b", { forceIdleImage: false });
  });

  it("stop() prevents timer rearming and later edits", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createCoordinator(refresh);

    const pending = coordinator.request("guild");
    const rejection = expect(pending).rejects.toThrow("Panel refresh coordinator stopped");
    coordinator.stop();
    await vi.advanceTimersByTimeAsync(maxWaitMs);

    await rejection;
    expect(refresh).not.toHaveBeenCalled();

    const afterStop = coordinator.request("guild");
    await vi.advanceTimersByTimeAsync(maxWaitMs);
    await expect(afterStop).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stopGuild() cancels only that guild and lets a later request resume normally", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createCoordinator(refresh);

    const pending = coordinator.request("guild-a");
    const untouched = coordinator.request("guild-b");
    const rejection = expect(pending).rejects.toThrow("Panel refresh coordinator stopped");
    coordinator.stopGuild("guild-a");
    await vi.advanceTimersByTimeAsync(maxWaitMs);

    await rejection;
    await expect(untouched).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("guild-b", { forceIdleImage: false });

    const resumed = coordinator.request("guild-a");
    await vi.advanceTimersByTimeAsync(debounceMs);
    await expect(resumed).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith("guild-a", { forceIdleImage: false });
  });

  it("renders immediately without waiting for the debounce window", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = createCoordinator(refresh);

    const request = coordinator.request("guild", { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    await request;

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
