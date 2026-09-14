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
export function buildLyricsCacheKey(trackName: string, artistName: string): string {
  return `${trackName.trim().toLowerCase()}|${artistName.trim().toLowerCase()}`;
}
