export interface CachedLyricLine {
  readonly timestampMs: number;
  readonly line: string;
}

// A track's synced lyrics never change, so this cache has no expiry — a hit
// is trusted indefinitely.
export interface LyricsCacheStore {
  // undefined = never looked up before (a real cache miss). null = looked
  // up before and confirmed to have no synced lyrics (a cached negative
  // result, so that confirmed-absent case doesn't keep re-querying LRCLIB
  // either). An array = the cached synced lines.
  get(trackKey: string): Promise<readonly CachedLyricLine[] | null | undefined>;
  set(trackKey: string, lines: readonly CachedLyricLine[] | null): Promise<void>;
}

// Shared across every guild and bot instance — a track's lyrics don't
// depend on who's playing it, so normalizing title/artist into one key
// lets a lookup on one server benefit every other server too.
//
// Duration is part of the key (bucketed to the nearest second, so a few ms
// of encoder jitter between plays of the same track can't split it into two
// keys) because title/artist alone isn't unique enough: a live/remastered/
// radio-edit recording can share the exact same title and artist text as
// the original while actually having different, unsynced-to-it timings.
// Without duration, whichever version got cached first — including a cached
// "no lyrics" negative result — would incorrectly serve every other
// same-titled recording indefinitely.
export function buildLyricsCacheKey(trackName: string, artistName: string, durationMs?: number): string {
  const durationBucket = durationMs !== undefined ? Math.round(durationMs / 1000) : "";
  // Version the matcher result so previously cached false negatives are
  // rechecked after search and ranking changes.
  return `v2|${trackName.trim().toLowerCase()}|${artistName.trim().toLowerCase()}|${durationBucket}`;
}
