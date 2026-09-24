import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSyncedLyrics, lyricsCacheIdentity } from "../../src/infrastructure/lyrics/lrclib-client.js";
import { buildLyricsCacheKey } from "../../src/application/lyrics/lyrics-cache-store.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]): Promise<unknown> => Promise.resolve(fetchMock(...args) as unknown));

function jsonResponse(status: number, body: unknown): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: (): Promise<unknown> => Promise.resolve(body),
  };
}

let nextCandidateId = 1;

function candidate(overrides: Partial<{
  id: number;
  trackName: string;
  artistName: string;
  duration: number | null;
  syncedLyrics: string | null;
  plainLyrics: string | null;
}> = {}): unknown {
  return {
    id: nextCandidateId++,
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
  nextCandidateId = 1;
});

describe("fetchSyncedLyrics", () => {
  it("keeps a legitimate hyphenated title as a search hypothesis", async () => {
    fetchMock.mockImplementation((url: unknown) => jsonResponse(200,
      new URL(String(url)).searchParams.get("track_name") === "Good Time - Live"
        ? [candidate({ trackName: "Good Time - Live" })] : [],
    ));

    expect(await fetchSyncedLyrics("Good Time - Live", "Owl City, Carly Rae Jepsen"))
      .toEqual([{ timestampMs: 1_000, line: "First line" }, { timestampMs: 2_500, line: "Second line" }]);
  });

  it("splits a CJK-bracketed title and strips an unbracketed video suffix", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const params = new URL(String(url)).searchParams;
      return jsonResponse(200, params.get("track_name") === "夜曲 Nocturne" && params.get("artist_name") === "周杰倫 Jay Chou"
        ? [candidate({ trackName: "夜曲 Nocturne", artistName: "周杰倫 Jay Chou", duration: 222 })] : []);
    });
    expect(await fetchSyncedLyrics("周杰倫 Jay Chou【夜曲 Nocturne】-Official Music Video", "JVR Music"))
      .toEqual([{ timestampMs: 1_000, line: "First line" }, { timestampMs: 2_500, line: "Second line" }]);
  });

  it("treats Traditional and Simplified Chinese metadata as the same song", async () => {
    fetchMock.mockImplementation((url: unknown) => jsonResponse(200,
      new URL(String(url)).searchParams.get("track_name") === "说好的幸福呢"
        ? [candidate({ trackName: "说好的幸福呢", artistName: "周杰伦" })] : [],
    ));
    expect(await fetchSyncedLyrics("說好的幸福呢", "周杰倫")).not.toBeNull();
  });

  it("takes a Japanese-quoted title when the text before it is the artist", async () => {
    fetchMock.mockImplementation((url: unknown) => jsonResponse(200,
      new URL(String(url)).searchParams.get("track_name") === "Bling-Bang-Bang-Born"
        ? [candidate({ trackName: "Bling-Bang-Bang-Born", artistName: "Creepy Nuts" })] : [],
    ));
    expect(await fetchSyncedLyrics(
      "Creepy Nuts｢Bling-Bang-Bang-Born｣ × TV Anime｢マッシュル-MASHLE-｣ Collaboration Music Video #BBBBダンス",
      "Creepy Nuts",
    )).not.toBeNull();
  });

  it("ignores a Japanese-quoted segment when the text before it isn't the artist", async () => {
    fetchMock.mockImplementation((url: unknown) => jsonResponse(200,
      new URL(String(url)).searchParams.get("track_name") === "Show"
        ? [candidate({ trackName: "Show", artistName: "Some Artist" })] : [],
    ));
    expect(await fetchSyncedLyrics("TV Anime「Show」 Opening", "Some Artist")).toBeNull();
  });

  it("rejects a different artist whose name merely contains the requested name", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate({ artistName: "Heartless" })]));
    expect(await fetchSyncedLyrics("Good Time", "Heart", 205_000)).toBeNull();
  });

  it("keeps a song title that begins with the artist's name", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate({ trackName: "Talk Talk", artistName: "Talk" })]));
    expect(await fetchSyncedLyrics("Talk Talk", "Talk")).not.toBeNull();
  });

  it("does not discard a usable release when row IDs are absent", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [
      { trackName: "Good Time", artistName: "Owl City", duration: 205, syncedLyrics: null },
      { trackName: "Good Time", artistName: "Owl City", duration: 205, syncedLyrics: "[00:01.00]Found" },
    ]));
    expect(await fetchSyncedLyrics("Good Time", "Owl City"))
      .toEqual([{ timestampMs: 1_000, line: "Found" }]);
  });

  it("expands repeated timestamps instead of displaying the extra timestamp as text", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate({ artistName: "Owl City", syncedLyrics: "[00:01.00][00:03.00]Chorus" })]));
    expect(await fetchSyncedLyrics("Good Time", "Owl City"))
      .toEqual([{ timestampMs: 1_000, line: "Chorus" }, { timestampMs: 3_000, line: "Chorus" }]);
  });

  it("does not merge lookups with different scoring artists in the cache", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const artist = requestedArtist(url);
      return jsonResponse(200, artist === "Artist B" || artist === "Artist C"
        ? [candidate({ trackName: "Home", artistName: artist, syncedLyrics: `[00:01.00]${artist}` })] : []);
    });
    const first = lyricsCacheIdentity("Artist A - Home", "Artist B");
    const second = lyricsCacheIdentity("Artist A - Home", "Artist C");
    const firstLines = await fetchSyncedLyrics("Artist A - Home", "Artist B", 200_000);
    const secondLines = await fetchSyncedLyrics("Artist A - Home", "Artist C", 200_000);
    expect(firstLines).not.toEqual(secondLines);
    expect(buildLyricsCacheKey(first.title, first.artist, 200_000))
      .not.toBe(buildLyricsCacheKey(second.title, second.artist, 200_000));
  });

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
        candidate({ duration: 205, syncedLyrics: null, plainLyrics: null }),
        candidate({ duration: 206, syncedLyrics: "[00:00.00]The real line" }),
      ]),
    );

    const lines = await fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen");

    expect(lines).toEqual([{ timestampMs: 0, line: "The real line" }]);
  });

  it("keeps two distinct LRCLIB rows separate even when title/artist/duration are identical", async () => {
    // A single re-released on a compilation at the exact same duration as
    // the original is a real LRCLIB shape — only `id` reliably tells the
    // rows apart. Deduping on title/artist/duration alone would discard
    // whichever of these carries the synced lyrics the other one lacks.
    fetchMock.mockResolvedValue(
      jsonResponse(200, [
        candidate({ duration: 205, syncedLyrics: null, plainLyrics: null }),
        candidate({ duration: 205, syncedLyrics: "[00:00.00]The real line" }),
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
    // Every artist variant is searched concurrently (not stopped at the
    // first confident match), so only the "Owl City" request should return
    // the real candidate — the others (the messy channel name, and the
    // empty-artist fallback) return nothing, same as LRCLIB genuinely would.
    fetchMock.mockImplementation((url: unknown) => Promise.resolve(jsonResponse(
      200,
      requestedArtist(url) === "Owl City" ? [candidate({ artistName: "Owl City" })] : [],
    )));

    const lines = await fetchSyncedLyrics(
      "Owl City - Good Time (Official Video)",
      "OwlCityVEVO",
    );

    expect(lines).toEqual([
      { timestampMs: 1_000, line: "First line" },
      { timestampMs: 2_500, line: "Second line" },
    ]);
    expect(fetchMock.mock.calls.some((call) => requestedArtist(call[0]) === "Owl City")).toBe(true);
  });

  it("derives artist/title from \"Artist - Title\" even with no metadata suffix to strip", async () => {
    // Regression: the split used to only run when stripMetadataSuffix
    // actually changed something, so a title that arrives as a clean
    // "Artist - Title" (nothing to strip) searched LRCLIB for that literal
    // string and never found the real "OneRepublic" / "Counting Stars" row.
    fetchMock.mockImplementation((url: unknown) => Promise.resolve(jsonResponse(
      200,
      requestedArtist(url) === "OneRepublic"
        ? [candidate({ trackName: "Counting Stars", artistName: "OneRepublic" })]
        : [],
    )));

    const lines = await fetchSyncedLyrics("OneRepublic - Counting Stars", "OneRepublic - Topic");

    expect(lines).toEqual([
      { timestampMs: 1_000, line: "First line" },
      { timestampMs: 2_500, line: "Second line" },
    ]);
    expect(fetchMock.mock.calls.some((call) => requestedArtist(call[0]) === "OneRepublic")).toBe(true);
  });

  it("finds a match via an individual artist name even when the full multi-artist credit finds nothing", async () => {
    // Regression: this used to run sequentially, stopping at the first
    // confident match — a multi-artist credit's own individual-name variants
    // then only got tried once the full combined credit had already come
    // back empty, adding that request's full latency before even starting
    // the one that would actually succeed. All variants fire together now.
    fetchMock.mockImplementation((url: unknown) => Promise.resolve(jsonResponse(
      200,
      requestedArtist(url) === "Owl City" ? [candidate({ artistName: "Owl City" })] : [],
    )));

    const lines = await fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen");

    expect(lines).toEqual([
      { timestampMs: 1_000, line: "First line" },
      { timestampMs: 2_500, line: "Second line" },
    ]);
    expect(fetchMock.mock.calls.some((call) => requestedArtist(call[0]) === "Owl City, Carly Rae Jepsen")).toBe(true);
    expect(fetchMock.mock.calls.some((call) => requestedArtist(call[0]) === "Owl City")).toBe(true);
  });

  it("fires every artist variant concurrently instead of waiting for each one in turn", async () => {
    // Regression: sequential awaiting meant a slow or empty response for the
    // first variant delayed even starting the next one — for a multi-artist
    // credit (2-4 variants), that's their combined latency before the panel
    // had anything to show, sometimes many seconds. All requests must be in
    // flight together, not started one after another.
    const pendingRequests: string[] = [];
    fetchMock.mockImplementation((url: unknown) => {
      const artist = requestedArtist(url) ?? "";
      pendingRequests.push(artist);
      return new Promise((resolve) => {
        setTimeout(() => resolve(jsonResponse(
          200,
          artist === "Owl City" ? [candidate({ artistName: "Owl City" })] : [],
        )), 0);
      });
    });

    const lyricsPromise = fetchSyncedLyrics("Good Time", "Owl City, Carly Rae Jepsen");
    // Before yielding to the event loop at all, every variant's request must
    // already have been issued — proving they were fired together rather
    // than one waiting on the previous one's response.
    expect(pendingRequests.sort()).toEqual(
      ["Owl City, Carly Rae Jepsen", "Owl City", "Carly Rae Jepsen", ""].sort(),
    );

    await lyricsPromise;
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
