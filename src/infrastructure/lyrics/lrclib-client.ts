import { z } from "zod";

const lrcLibResultSchema = z.object({
  syncedLyrics: z.string().nullable().optional(),
});
const lrcLibResponseSchema = z.array(lrcLibResultSchema);

export interface SyncedLyricLine {
  readonly timestampMs: number;
  readonly line: string;
}

const lrcLineExpression = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/;

function parseSyncedLyrics(syncedLyrics: string): SyncedLyricLine[] {
  const lines: SyncedLyricLine[] = [];
  for (const rawLine of syncedLyrics.split("\n")) {
    const match = lrcLineExpression.exec(rawLine.trim());
    if (!match) continue;
    const text = match[3]?.trim();
    if (!text) continue;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    lines.push({ timestampMs: Math.round((minutes * 60 + seconds) * 1000), line: text });
  }
  return lines.sort((a, b) => a.timestampMs - b.timestampMs);
}

// LavaSrc's own lrcLib integration always uses the first search result even
// when that entry has no synced lyrics, which silently fails for tracks with
// several LRCLIB entries (e.g. multi-artist credits) where the top-ranked
// hit happens to be an instrumental or alternate release. We query the same
// public API directly and pick the first result that actually has synced
// lyrics instead.
export async function fetchSyncedLyrics(
  trackName: string,
  artistName: string,
): Promise<SyncedLyricLine[] | null> {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("track_name", trackName);
  url.searchParams.set("artist_name", artistName);
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const results = lrcLibResponseSchema.parse(await response.json());
  for (const result of results) {
    if (!result.syncedLyrics) continue;
    const lines = parseSyncedLyrics(result.syncedLyrics);
    if (lines.length > 0) return lines;
  }
  return null;
}
