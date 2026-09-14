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

function candidate(overrides: Partial<{
  trackName: string;
  artistName: string;
  duration: number | null;
  syncedLyrics: string | null;
  plainLyrics: string | null;
}> = {}): unknown {
  return {
    trackName: "Good Time",
    artistName: "Owl City, Carly Rae Jepsen",
    duration: 205,
    syncedLyrics: "[00:01.00]First line\n[00:02.50]Second line",
    plainLyrics: null,
    ...overrides,
  };
}

function requestedArtist(url: unknown): string | null {
  return new URL(String(url)).searchParams.get("artist_name");
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("fetchSyncedLyrics", () => {
  it("matches a clean title/artist and returns its parsed lines", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate()]));

    const lines = await fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen");

    expect(lines).toEqual([
      { timestampMs: 1_000, line: "First line" },
      { timestampMs: 2_500, line: "Second line" },
    ]);
  });

  it("skips a top-ranked result with no synced lyrics in favor of an equally-good match that has them", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [
        // Distinct albums/durations here purely so the two entries don't
        // collapse into one under LRCLIB-search result de-duplication —
        // real duplicate rows this identical wouldn't happen in practice.
        candidate({ duration: 205, syncedLyrics: null, plainLyrics: null }),
        candidate({ duration: 206, syncedLyrics: "[00:00.00]The real line" }),
      ]),
    );

    const lines = await fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen");

    expect(lines).toEqual([{ timestampMs: 0, line: "The real line" }]);
  });

  it("rejects a candidate whose title doesn't actually match, even with synced lyrics", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [candidate({ trackName: "A Completely Different Song" })]),
    );

    expect(await fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen")).toBeNull();
  });

  it("rejects a candidate whose duration is too far off", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate({ duration: 400 })]));

    expect(await fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen", 205_000)).toBeNull();
  });

  it("prefers a matching version over a live/remix candidate with the same title", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [
        candidate({ trackName: "Good Time (Live)", syncedLyrics: "[00:00.00]Live version" }),
      ]),
    );

    expect(await fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen")).toBeNull();
  });

  it("strips a YouTube-style title suffix and derives artist/title from \"Artist - Title\"", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      expect(requestedArtist(url)).toBe("Owl City");
      return Promise.resolve(jsonResponse(200, [candidate({ artistName: "Owl City" })]));
    });

    const lines = await fetchSyncedLyrics(
      "Owl City - Good Time (Official Video)",
      "OwlCityVEVO",
    );

    expect(lines).toEqual([
      { timestampMs: 1_000, line: "First line" },
      { timestampMs: 2_500, line: "Second line" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to an individual artist name when the full multi-artist credit finds nothing", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const artist = requestedArtist(url);
      if (artist === "Owl City, Carly Rae Jepsen") return Promise.resolve(jsonResponse(200, []));
      expect(artist).toBe("Owl City");
      return Promise.resolve(jsonResponse(200, [candidate({ artistName: "Owl City" })]));
    });

    const lines = await fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen");

    expect(lines).toEqual([
      { timestampMs: 1_000, line: "First line" },
      { timestampMs: 2_500, line: "Second line" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("matches a vocalist credited as \"name from group\" against just the plain name", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [
        candidate({
          trackName: "Neko Hi",
          artistName: "suis from Yorushika",
          syncedLyrics: "[00:00.00]Only line",
        }),
      ]),
    );

    const lines = await fetchSyncedLyrics("Neko Hi", "suis");

    expect(lines).toEqual([{ timestampMs: 0, line: "Only line" }]);
  });

  it("returns null when no artist variant finds a confident match", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));

    expect(await fetchSyncedLyrics("Nothing", "Nobody")).toBeNull();
  });

  it("sorts parsed lines by timestamp even if the source text is out of order", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [candidate({ syncedLyrics: "[01:00.00]Later\n[00:00.00]Earlier" })]),
    );

    const lines = await fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen");

    expect(lines?.map((line) => line.line)).toEqual(["Earlier", "Later"]);
  });

  it("throws on a non-OK response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, []));

    await expect(fetchSyncedLyrics("Track", "Artist")).rejects.toThrow("HTTP 500");
  });
});
