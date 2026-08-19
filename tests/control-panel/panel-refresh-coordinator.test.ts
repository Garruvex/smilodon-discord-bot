import { describe, expect, it, vi } from "vitest";

import { PanelRefreshCoordinator } from "../../src/application/control-panel/panel-refresh-coordinator.js";

describe("PanelRefreshCoordinator", () => {
  it("serializes edits and follows an in-flight stale render with the latest state", async () => {
    let state = "old";
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const rendered: string[] = [];
    const refresh = vi.fn(async (): Promise<void> => {
      const captured = state;
      if (rendered.length === 0) await firstGate;
      rendered.push(captured);
    });
    const coordinator = new PanelRefreshCoordinator(refresh);

    const oldRefresh = coordinator.request("guild");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    state = "latest";
    const latestRefresh = coordinator.request("guild");
    releaseFirst();
    await Promise.all([oldRefresh, latestRefresh]);

    expect(rendered).toEqual(["old", "latest"]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst received during one edit into one follow-up edit", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const refresh = vi.fn()
      .mockImplementationOnce(() => firstGate)
      .mockResolvedValue(undefined);
    const coordinator = new PanelRefreshCoordinator(refresh);

    const requests = [coordinator.request("guild")];
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    requests.push(
      coordinator.request("guild"),
      coordinator.request("guild"),
      coordinator.request("guild"),
    );
    releaseFirst();
    await Promise.all(requests);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps different guilds independent", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = new PanelRefreshCoordinator(refresh);

    await Promise.all([
      coordinator.request("guild-a"),
      coordinator.request("guild-b"),
    ]);

    expect(refresh).toHaveBeenCalledWith("guild-a", { forceIdleImage: false });
    expect(refresh).toHaveBeenCalledWith("guild-b", { forceIdleImage: false });
  });
});
