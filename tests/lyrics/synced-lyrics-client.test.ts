import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  lookupSyncedLyrics,
  lyricsCacheIdentity,
  type SyncedLyricLine,
} from "../../src/infrastructure/lyrics/synced-lyrics-client.js";
import { buildLyricsCacheKey } from "../../src/application/lyrics/lyrics-cache-store.js";

// Most tests only care which lines were matched: lines for "found", null for
// "not_found", and a rejection naming the error code for "unavailable".
async function fetchLines(trackName: string, artistName: string, durationMs?: number): Promise<SyncedLyricLine[] | null> {
  const { result } = await lookupSyncedLyrics(trackName, artistName, durationMs);
  if (result.status === "found") return result.lines;
  if (result.status === "not_found") return null;
  throw new Error(`${result.source}: ${result.errorCode}`);
}

// LRCLIB and the NetEase fallback get separate mocks, so LRCLIB-focused
// tests keep asserting on LRCLIB traffic alone. NetEase finds nothing
// unless a test says otherwise.
const fetchMock = vi.fn();
const netEaseFetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]): Promise<unknown> => {
  const mock = new URL(String(args[0])).hostname === "music.163.com" ? netEaseFetchMock : fetchMock;
  return Promise.resolve(mock(...args) as unknown);
});

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

function netEaseSong(overrides: Partial<{ id: number; name: string; duration: number; artists: string[] }> = {}): unknown {
  const { artists = ["Creepy Nuts"], ...rest } = overrides;
  return { id: 1, name: "Bling-Bang-Bang-Born", duration: 168_205, ...rest, artists: artists.map((name) => ({ name })) };
}

beforeEach(() => {
  fetchMock.mockReset();
  netEaseFetchMock.mockReset();
  netEaseFetchMock.mockReturnValue(jsonResponse(200, { code: 200, result: { songs: [] } }));
  nextCandidateId = 1;
});

describe("NetEase fallback", () => {
  beforeEach(() => {
    fetchMock.mockReturnValue(jsonResponse(200, []));
  });

  it("uses NetEase lyrics when LRCLIB has no match, skipping covers", async () => {
    netEaseFetchMock.mockImplementation((url: unknown) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/search/get") {
        return jsonResponse(200, { code: 200, result: { songs: [
          netEaseSong({ id: 7, artists: ["Some Cover Singer"] }),
          netEaseSong({ id: 8 }),
        ] } });
      }
      return jsonResponse(200, { code: 200, lrc: { lyric: `[00:01.00]from ${parsed.searchParams.get("id")}` } });
    });

    expect(await fetchLines("Bling-Bang-Bang-Born", "Creepy Nuts", 168_000))
      .toEqual([{ timestampMs: 1_000, line: "from 8" }]);
  });

  it("matches one credited artist out of several", async () => {
    netEaseFetchMock.mockImplementation((url: unknown) => new URL(String(url)).pathname === "/api/search/get"
      ? jsonResponse(200, { code: 200, result: { songs: [netEaseSong({ artists: ["Creepy Nuts", "Guest"] })] } })
      : jsonResponse(200, { code: 200, lrc: { lyric: "[00:01.00]Found" } }));
    expect(await fetchLines("Bling-Bang-Bang-Born", "Creepy Nuts")).not.toBeNull();
  });

  it("treats a NetEase block code as a retryable throttle rather than a cacheable miss", async () => {
    netEaseFetchMock.mockReturnValue(jsonResponse(200, { code: -460, msg: "Cheating" }));
    const { result, attempts } = await lookupSyncedLyrics("Bling-Bang-Bang-Born", "Creepy Nuts");
    expect(result).toEqual({ status: "unavailable", source: "netease", errorCode: "rate_limited", retryable: true });
    expect(attempts.map(({ source, outcome, errorCode }) => ({ source, outcome, errorCode }))).toEqual([
      { source: "lrclib", outcome: "not_found", errorCode: undefined },
      { source: "netease", outcome: "failed", errorCode: "rate_limited" },
    ]);
  });

  it("maps an unknown NetEase code to a non-retryable provider error", async () => {
    netEaseFetchMock.mockReturnValue(jsonResponse(200, { code: 400 }));
    expect((await lookupSyncedLyrics("Bling-Bang-Bang-Born", "Creepy Nuts")).result)
      .toMatchObject({ status: "unavailable", errorCode: "provider_error", retryable: false });
  });

  it("finds lyrics on NetEase after LRCLIB fails outright", async () => {
    fetchMock.mockReturnValue(jsonResponse(503, "Service Unavailable"));
    netEaseFetchMock.mockImplementation((url: unknown) => new URL(String(url)).pathname === "/api/search/get"
      ? jsonResponse(200, { code: 200, result: { songs: [netEaseSong()] } })
      : jsonResponse(200, { code: 200, lrc: { lyric: "[00:01.00]Found" } }));

    const { result, attempts } = await lookupSyncedLyrics("Bling-Bang-Bang-Born", "Creepy Nuts");

    expect(result).toEqual({ status: "found", source: "netease", lines: [{ timestampMs: 1_000, line: "Found" }] });
    expect(attempts.map(({ source, outcome, errorCode }) => ({ source, outcome, errorCode }))).toEqual([
      { source: "lrclib", outcome: "failed", errorCode: "http_error" },
      { source: "netease", outcome: "found", errorCode: undefined },
    ]);
  });

  it("returns null when neither provider has a confident match", async () => {
    expect(await fetchLines("Bling-Bang-Bang-Born", "Creepy Nuts")).toBeNull();
  });

  it("never asks NetEase when LRCLIB already found lyrics", async () => {
    fetchMock.mockReturnValue(jsonResponse(200, [candidate()]));
    expect(await fetchLines("Good Time", "Owl City, Carly Rae Jepsen")).not.toBeNull();
    expect(netEaseFetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchSyncedLyrics", () => {
  it("keeps a legitimate hyphenated title as a search hypothesis", async () => {
    fetchMock.mockImplementation((url: unknown) => jsonResponse(200,
      new URL(String(url)).searchParams.get("track_name") === "Good Time - Live"
        ? [candidate({ trackName: "Good Time - Live" })] : [],
    ));

    expect(await fetchLines("Good Time - Live", "Owl City, Carly Rae Jepsen"))
      .toEqual([{ timestampMs: 1_000, line: "First line" }, { timestampMs: 2_500, line: "Second line" }]);
  });

  it("splits a CJK-bracketed title and strips an unbracketed video suffix", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const params = new URL(String(url)).searchParams;
      return jsonResponse(200, params.get("track_name") === "夜曲 Nocturne" && params.get("artist_name") === "周杰倫 Jay Chou"
        ? [candidate({ trackName: "夜曲 Nocturne", artistName: "周杰倫 Jay Chou", duration: 222 })] : []);
    });
    expect(await fetchLines("周杰倫 Jay Chou【夜曲 Nocturne】-Official Music Video", "JVR Music"))
      .toEqual([{ timestampMs: 1_000, line: "First line" }, { timestampMs: 2_500, line: "Second line" }]);
  });

  it("finds the linked Jay Chou video using its 〖song〗 title", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      const params = new URL(String(url)).searchParams;
      return jsonResponse(200, params.get("track_name") === "晴天" && params.get("artist_name") === null
        ? [candidate({ trackName: "晴天", artistName: "周杰倫", duration: 269 })] : []);
    });
    expect(await fetchLines("周杰倫 Jay Chou〖晴天 Sunny Day〗-Official Music Video", "JVR Music"))
      .not.toBeNull();
  });

  it.each([
    ["【", "】"], ["《", "》"], ["〖", "〗"], ["〈", "〉"],
    ["「", "」"], ["『", "』"], ["〔", "〕"], ["［", "］"],
    ["[", "]"], ["（", "）"], ["(", ")"], ["｢", "｣"],
    ["｛", "｝"], ["{", "}"], ["⟦", "⟧"], ["⟨", "⟩"],
  ])("extracts a song from paired %s%s brackets", async (open, close) => {
    fetchMock.mockImplementation((url: unknown) => {
      const params = new URL(String(url)).searchParams;
      return jsonResponse(200, params.get("track_name") === "晴天" && params.get("artist_name") === "周杰倫"
        ? [candidate({ trackName: "晴天", artistName: "周杰倫" })] : []);
    });
    expect(await fetchLines(`周杰倫${open}晴天${close}-Official Music Video`, "JVR Music"))
      .not.toBeNull();
  });

  it("does not extract a title from mismatched brackets", async () => {
    fetchMock.mockImplementation((url: unknown) => jsonResponse(200,
      new URL(String(url)).searchParams.get("track_name") === "晴天"
        ? [candidate({ trackName: "晴天", artistName: "周杰倫" })] : [],
    ));
    expect(await fetchLines("周杰倫【晴天》-Official Music Video", "JVR Music")).toBeNull();
  });

  it("matches a bilingual title and artist against the one-language row LRCLIB has", async () => {
    fetchMock.mockImplementation((url: unknown) => jsonResponse(200,
      new URL(String(url)).searchParams.get("track_name") === "髮如雪" && requestedArtist(url) === null
        ? [candidate({ trackName: "髮如雪", artistName: "周杰倫", duration: 302 })] : [],
    ));
    expect(await fetchLines("周杰倫 Jay Chou【髮如雪 Hair White as Snow】-Official Music Video", "JVR Music", 305_000))
      .not.toBeNull();
  });

  it("matches the Latin half of a bilingual artist credit", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate({ trackName: "晴天", artistName: "Jay Chou" })]));
    expect(await fetchLines("晴天", "周杰倫 Jay Chou")).not.toBeNull();
  });

  it("doesn't treat an ordinary multi-word artist as bilingual", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate({ trackName: "Good Time", artistName: "Owl" })]));
    expect(await fetchLines("Good Time", "Owl City")).toBeNull();
  });

  it("treats Traditional and Simplified Chinese metadata as the same song", async () => {
    fetchMock.mockImplementation((url: unknown) => jsonResponse(200,
      new URL(String(url)).searchParams.get("track_name") === "说好的幸福呢"
        ? [candidate({ trackName: "说好的幸福呢", artistName: "周杰伦" })] : [],
    ));
    expect(await fetchLines("說好的幸福呢", "周杰倫")).not.toBeNull();
  });

  it("takes a Japanese-quoted title when the text before it is the artist", async () => {
    fetchMock.mockImplementation((url: unknown) => jsonResponse(200,
      new URL(String(url)).searchParams.get("track_name") === "Bling-Bang-Bang-Born"
        ? [candidate({ trackName: "Bling-Bang-Bang-Born", artistName: "Creepy Nuts" })] : [],
    ));
    expect(await fetchLines(
      "Creepy Nuts｢Bling-Bang-Bang-Born｣ × TV Anime｢マッシュル-MASHLE-｣ Collaboration Music Video #BBBBダンス",
      "Creepy Nuts",
    )).not.toBeNull();
  });

  it("ignores a Japanese-quoted segment when the text before it isn't the artist", async () => {
    fetchMock.mockImplementation((url: unknown) => jsonResponse(200,
      new URL(String(url)).searchParams.get("track_name") === "Show"
        ? [candidate({ trackName: "Show", artistName: "Some Artist" })] : [],
    ));
    expect(await fetchLines("TV Anime「Show」 Opening", "Some Artist")).toBeNull();
  });

  it("rejects a different artist whose name merely contains the requested name", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate({ artistName: "Heartless" })]));
    expect(await fetchLines("Good Time", "Heart", 205_000)).toBeNull();
  });

  it("keeps a song title that begins with the artist's name", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate({ trackName: "Talk Talk", artistName: "Talk" })]));
    expect(await fetchLines("Talk Talk", "Talk")).not.toBeNull();
  });

  it("does not discard a usable release when row IDs are absent", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [
      { trackName: "Good Time", artistName: "Owl City", duration: 205, syncedLyrics: null },
      { trackName: "Good Time", artistName: "Owl City", duration: 205, syncedLyrics: "[00:01.00]Found" },
    ]));
    expect(await fetchLines("Good Time", "Owl City"))
      .toEqual([{ timestampMs: 1_000, line: "Found" }]);
  });

  it("expands repeated timestamps instead of displaying the extra timestamp as text", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate({ artistName: "Owl City", syncedLyrics: "[00:01.00][00:03.00]Chorus" })]));
    expect(await fetchLines("Good Time", "Owl City"))
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
    const firstLines = await fetchLines("Artist A - Home", "Artist B", 200_000);
    const secondLines = await fetchLines("Artist A - Home", "Artist C", 200_000);
    expect(firstLines).not.toEqual(secondLines);
    expect(buildLyricsCacheKey(first.title, first.artist, 200_000))
      .not.toBe(buildLyricsCacheKey(second.title, second.artist, 200_000));
  });

  it("matches a clean title/artist and returns its parsed lines", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate()]));

    const lines = await fetchLines("Good Time", "Owl City, Carly Rae Jepsen");

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

    const lines = await fetchLines("Good Time", "Owl City, Carly Rae Jepsen");

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

    const lines = await fetchLines("Good Time", "Owl City, Carly Rae Jepsen");

    expect(lines).toEqual([{ timestampMs: 0, line: "The real line" }]);
  });

  it("rejects a candidate whose title doesn't actually match, even with synced lyrics", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [candidate({ trackName: "A Completely Different Song" })]),
    );

    expect(await fetchLines("Good Time", "Owl City, Carly Rae Jepsen")).toBeNull();
  });

  it("rejects a candidate whose duration is too far off", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, [candidate({ duration: 400 })]));

    expect(await fetchLines("Good Time", "Owl City, Carly Rae Jepsen", 205_000)).toBeNull();
  });

  it("prefers a matching version over a live/remix candidate with the same title", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [
        candidate({ trackName: "Good Time (Live)", syncedLyrics: "[00:00.00]Live version" }),
      ]),
    );

    expect(await fetchLines("Good Time", "Owl City, Carly Rae Jepsen")).toBeNull();
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

    const lines = await fetchLines(
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

    const lines = await fetchLines("OneRepublic - Counting Stars", "OneRepublic - Topic");

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

    const lines = await fetchLines("Good Time", "Owl City, Carly Rae Jepsen");

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

    const lyricsPromise = fetchLines("Good Time", "Owl City, Carly Rae Jepsen");
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

    const lines = await fetchLines("Neko Hi", "suis");

    expect(lines).toEqual([{ timestampMs: 0, line: "Only line" }]);
  });

  it("returns null when no artist variant finds a confident match", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []));

    expect(await fetchLines("Nothing", "Nobody")).toBeNull();
  });

  it("sorts parsed lines by timestamp even if the source text is out of order", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [candidate({ syncedLyrics: "[01:00.00]Later\n[00:00.00]Earlier" })]),
    );

    const lines = await fetchLines("Good Time", "Owl City, Carly Rae Jepsen");

    expect(lines?.map((line) => line.line)).toEqual(["Earlier", "Later"]);
  });

  it("reports a server error as a retryable outage", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, []));

    expect((await lookupSyncedLyrics("Track", "Artist")).result)
      .toEqual({ status: "unavailable", source: "lrclib", errorCode: "http_error", retryable: true });
  });
});

describe("settling early on a confident LRCLIB match", () => {
  // A search that never answers on its own — only cancellation ends it.
  function hangingResponse(init: unknown): Promise<unknown> {
    const signal = (init as { signal: AbortSignal }).signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  }

  it("returns an exact match without waiting for slower searches, and cancels them", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((url: unknown, init: unknown) => {
      signals.push((init as { signal: AbortSignal }).signal);
      return requestedArtist(url) === "Owl City, Carly Rae Jepsen"
        ? jsonResponse(200, [candidate({ duration: 205 })])
        : hangingResponse(init);
    });

    expect(await fetchLines("Good Time", "Owl City, Carly Rae Jepsen", 205_000))
      .toEqual([{ timestampMs: 1_000, line: "First line" }, { timestampMs: 2_500, line: "Second line" }]);
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("waits for every search when the first match isn't confident, so a better one can win", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (requestedArtist(url) === "Owl City, Carly Rae Jepsen") {
        // 10s off the track's duration: a valid match, but not a confident one.
        return jsonResponse(200, [candidate({ duration: 215, syncedLyrics: "[00:01.00]Radio edit" })]);
      }
      if (requestedArtist(url) === null) {
        return new Promise((resolve) => setTimeout(() => resolve(jsonResponse(200, [
          candidate({ duration: 205, syncedLyrics: "[00:01.00]Album version" }),
        ])), 20));
      }
      return jsonResponse(200, []);
    });

    expect(await fetchLines("Good Time", "Owl City, Carly Rae Jepsen", 205_000))
      .toEqual([{ timestampMs: 1_000, line: "Album version" }]);
  });

  it("settles on a weaker match after a short grace period instead of waiting on a hanging search", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((url: unknown, init: unknown) => requestedArtist(url) === "Owl City, Carly Rae Jepsen"
        ? jsonResponse(200, [candidate({ duration: 215, syncedLyrics: "[00:01.00]Radio edit" })])
        : hangingResponse(init));

      const lines = fetchLines("Good Time", "Owl City, Carly Rae Jepsen", 205_000);
      await vi.advanceTimersByTimeAsync(1_500);

      expect(await lines).toEqual([{ timestampMs: 1_000, line: "Radio edit" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("provider error codes", () => {
  it.each([
    ["a timeout", (): Promise<never> => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })), "timeout", true],
    ["a network failure", (): Promise<never> => Promise.reject(new TypeError("fetch failed")), "network", true],
    ["HTTP 429", (): unknown => jsonResponse(429, {}), "rate_limited", true],
    ["HTTP 404", (): unknown => jsonResponse(404, {}), "http_error", false],
    ["a non-JSON body", (): unknown => ({ ok: true, status: 200, json: (): Promise<never> => Promise.reject(new SyntaxError("Unexpected token <")) }), "invalid_response", true],
    ["a non-array body", (): unknown => jsonResponse(200, { error: "nope" }), "invalid_response", false],
  ])("classifies %s from LRCLIB", async (_label, respond, errorCode, retryable) => {
    fetchMock.mockImplementation(respond);
    expect((await lookupSyncedLyrics("Track", "Artist")).result)
      .toEqual({ status: "unavailable", source: "lrclib", errorCode, retryable });
  });
});
