import { describe, expect, it, vi } from "vitest";

import { LavalinkAutoQueue } from "../../src/infrastructure/lavalink/lavalink-auto-queue.js";

interface TestTrack {
  info: {
    identifier: string;
    title: string;
    author: string;
    sourceName: string;
  };
  userData?: Record<string, unknown>;
}

function track(identifier: string): TestTrack {
  return {
    info: {
      identifier,
      title: "Rice Field",
      author: "Jay Chou",
      sourceName: "youtube",
    },
  };
}

describe("LavalinkAutoQueue", () => {
  it("queues the first unplayed track from the YouTube Related Mix", async () => {
    const source = track("source12345");
    const repeated = track("source12345");
    const recommendation = track("next1234567");
    const add = vi.fn().mockResolvedValue(undefined);
    const search = vi.fn().mockResolvedValue({ tracks: [repeated, recommendation] });
    const player = {
      search,
      queue: { previous: [], add },
    };

    await expect(
      new LavalinkAutoQueue().enqueueNext(player as never, source as never),
    ).resolves.toEqual({ status: "queued", trackIdentifier: "next1234567" });

    expect(search).toHaveBeenCalledWith(
      { query: "https://www.youtube.com/watch?v=source12345&list=RDsource12345" },
      { userId: "autoqueue" },
    );
    expect(add).toHaveBeenCalledWith(recommendation);
    expect(recommendation.userData?.requestedByUserId).toBe("autoqueue");
  });

  it("returns a failure outcome instead of interrupting Lavalink queueEnd", async () => {
    const player = {
      search: vi.fn().mockRejectedValue(new Error("YouTube unavailable")),
      queue: { previous: [], add: vi.fn() },
    };

    const result = await new LavalinkAutoQueue().enqueueNext(
      player as never,
      track("source12345") as never,
    );

    expect(result.status).toBe("failed");
    expect(player.search).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a valid search with no unplayed results from a failure", async () => {
    const source = track("source12345");
    const player = {
      search: vi.fn().mockResolvedValue({ tracks: [source] }),
      queue: { previous: [], add: vi.fn() },
    };

    await expect(
      new LavalinkAutoQueue().enqueueNext(player as never, source as never),
    ).resolves.toEqual({ status: "empty" });
  });
});
