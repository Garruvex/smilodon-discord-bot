import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import type { CachedLyricLine, LyricsCacheStore } from "../../application/lyrics/lyrics-cache-store.js";
import * as schema from "../database/schema.js";

const cachedLinesSchema = z.array(z.object({ timestampMs: z.number(), line: z.string() }));

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
    return row.lines === null ? null : cachedLinesSchema.parse(row.lines);
  }

  public async set(trackKey: string, lines: readonly CachedLyricLine[] | null): Promise<void> {
    await this.database
      .insert(schema.cachedLyrics)
      .values({ trackKey, lines })
      .onConflictDoUpdate({
        target: schema.cachedLyrics.trackKey,
        set: { lines },
      });
  }
}
