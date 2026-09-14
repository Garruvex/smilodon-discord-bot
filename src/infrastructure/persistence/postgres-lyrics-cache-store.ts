import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import type { CachedLyricLine, LyricsCacheStore } from "../../application/lyrics/lyrics-cache-store.js";
import * as schema from "../database/schema.js";

const cachedLinesSchema = z.array(z.object({ timestampMs: z.number(), line: z.string() }));

// A confirmed-found result never changes — LRCLIB's data for a specific
// release is stable. A confirmed-*not*-found one isn't nearly as trustworthy
// indefinitely, though: LRCLIB is a growing, community-maintained database
// (a track missing today can be added later), and a negative result can also
// just be a bug in *our own* matching logic at the time it was cached — a
// later fix to that logic doesn't retroactively un-cache the wrong answer it
// produced. Re-verifying negatives periodically catches both cases; positive
// results are exempt since there's nothing to re-verify.
const negativeResultTtlMs = 30 * 24 * 60 * 60 * 1000;

// Unlike this project's other Postgres stores, this one doesn't preload
// everything into memory at initialize() — cached_lyrics is shared across
// every guild and instance rather than scoped to one guild, so it can grow
// far larger than a birthday or control-panel table ever would. A per-key
// read is cheap enough (same-network Postgres round trip) that there's no
// need to hold the whole table in memory.
export class PostgresLyricsCacheStore implements LyricsCacheStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public async get(trackKey: string): Promise<readonly CachedLyricLine[] | null | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.cachedLyrics)
      .where(eq(schema.cachedLyrics.trackKey, trackKey))
      .limit(1);
    if (!row) return undefined;
    if (row.lines === null) {
      const ageMs = Date.now() - row.createdAt.getTime();
      // Treat an expired negative as a miss (undefined), not a confirmed
      // negative (null) — the caller re-queries LRCLIB and set() below
      // refreshes createdAt, restarting the TTL from whatever the fresh
      // answer turns out to be.
      if (ageMs > negativeResultTtlMs) return undefined;
      return null;
    }
    return cachedLinesSchema.parse(row.lines);
  }

  public async set(trackKey: string, lines: readonly CachedLyricLine[] | null): Promise<void> {
    await this.database
      .insert(schema.cachedLyrics)
      .values({ trackKey, lines })
      .onConflictDoUpdate({
        target: schema.cachedLyrics.trackKey,
        set: { lines, createdAt: new Date() },
      });
  }
}
