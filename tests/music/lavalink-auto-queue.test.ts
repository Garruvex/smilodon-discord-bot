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
      guildId: "guild-1",
      search,
      queue: { current: null, previous: [], tracks: [], add },
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
      guildId: "guild-1",
      search: vi.fn().mockRejectedValue(new Error("YouTube unavailable")),
      queue: { current: null, previous: [], tracks: [], add: vi.fn() },
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
      guildId: "guild-1",
      search: vi.fn().mockResolvedValue({ tracks: [source] }),
      queue: { current: null, previous: [], tracks: [], add: vi.fn() },
    };

    await expect(
      new LavalinkAutoQueue().enqueueNext(player as never, source as never),
    ).resolves.toEqual({ status: "empty" });
  });

  it("does not alternate between two related tracks when Lavalink history is empty", async () => {
    const first = track("track-a");
    const second = track("track-b");
    const third = track("track-c");
    const add = vi.fn().mockResolvedValue(undefined);
    const search = vi.fn()
      .mockResolvedValueOnce({ tracks: [first, second] })
      .mockResolvedValueOnce({ tracks: [second, first, third] });
    const player = {
      guildId: "guild-1",
      search,
      queue: { current: null, previous: [], tracks: [], add },
    };
    const autoQueue = new LavalinkAutoQueue();

    await expect(autoQueue.enqueueNext(player as never, first as never)).resolves.toEqual({
      status: "queued",
      trackIdentifier: "track-b",
    });
    await expect(autoQueue.enqueueNext(player as never, second as never)).resolves.toEqual({
      status: "queued",
      trackIdentifier: "track-c",
    });

    expect(add).toHaveBeenNthCalledWith(1, second);
    expect(add).toHaveBeenNthCalledWith(2, third);
  });

  it("keeps autoplay history isolated by guild and allows it to be cleared", async () => {
    const first = track("track-a");
    const second = track("track-b");
    const autoQueue = new LavalinkAutoQueue();
    const createPlayer = (guildId: string): Record<string, unknown> => ({
      guildId,
      search: vi.fn().mockResolvedValue({ tracks: [first, second] }),
      queue: { current: null, previous: [], tracks: [], add: vi.fn() },
    });
    const firstGuild = createPlayer("guild-1");
    const secondGuild = createPlayer("guild-2");

    await autoQueue.enqueueNext(firstGuild as never, first as never);
    await autoQueue.enqueueNext(secondGuild as never, second as never);
    autoQueue.clear("guild-1");

    await expect(autoQueue.enqueueNext(firstGuild as never, second as never)).resolves.toEqual({
      status: "queued",
      trackIdentifier: "track-a",
    });
    await expect(autoQueue.enqueueNext(secondGuild as never, second as never)).resolves.toEqual({
      status: "empty",
    });
  });
});
