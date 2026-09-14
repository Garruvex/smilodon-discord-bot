import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSyncedLyrics } from "../../src/infrastructure/lyrics/lrclib-client.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]): Promise<unknown> => Promise.resolve(fetchMock(...args) as unknown));

function jsonResponse(status: number, body: unknown): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: (): Promise<unknown> => Promise.resolve(body),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("fetchSyncedLyrics", () => {
  it("skips results with no synced lyrics and returns the first that has them", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [
        { syncedLyrics: null },
        { syncedLyrics: "[00:01.00]First line\n[00:02.50]Second line" },
        { syncedLyrics: "[00:00.00]Should not be reached" },
      ]),
    );

    const lines = await fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen");

    expect(lines).toEqual([
      { timestampMs: 1_000, line: "First line" },
      { timestampMs: 2_500, line: "Second line" },
    ]);
  });

  it("returns null when no result has synced lyrics", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [{ syncedLyrics: null }, { syncedLyrics: "" }]));

    expect(await fetchSyncedLyrics("Unknown Track", "Unknown Artist")).toBeNull();
  });

  it("returns null when the search has no results", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));

    expect(await fetchSyncedLyrics("Nothing", "Nobody")).toBeNull();
  });

  it("sorts parsed lines by timestamp even if the source text is out of order", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [{ syncedLyrics: "[01:00.00]Later\n[00:00.00]Earlier" }]),
    );

    const lines = await fetchSyncedLyrics("Track", "Artist");

    expect(lines?.map((line) => line.line)).toEqual(["Earlier", "Later"]);
  });

  it("throws on a non-OK response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, []));

    await expect(fetchSyncedLyrics("Track", "Artist")).rejects.toThrow("HTTP 500");
  });
});
