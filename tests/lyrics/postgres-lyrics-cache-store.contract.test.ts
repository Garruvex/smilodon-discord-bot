// Runs PostgresLyricsCacheStore's contract against a real Postgres instance.
// Skipped by default — set MEMORY_TEST_DATABASE_URL to run it, same as
// postgres-memory-repository.contract.test.ts.
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { PostgresLyricsCacheStore } from "../../src/infrastructure/persistence/postgres-lyrics-cache-store.js";
import * as schema from "../../src/infrastructure/database/schema.js";

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL;

if (!databaseUrl) {
  describe.skip("PostgresLyricsCacheStore contract", () => {
    it("requires MEMORY_TEST_DATABASE_URL to run — see this file's header comment", () => {});
  });
} else {
  const client = postgres(databaseUrl, { max: 5 });
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });

  async function store(): Promise<PostgresLyricsCacheStore> {
    await database.execute(sql`TRUNCATE TABLE cached_lyrics`);
    return new PostgresLyricsCacheStore(database);
  }

  async function backdateBy(days: number): Promise<void> {
    await database.execute(
      sql`UPDATE cached_lyrics SET created_at = now() - (${days} || ' days')::interval WHERE track_key = 'track|artist'`,
    );
  }

  describe("PostgresLyricsCacheStore contract", () => {
    it("returns undefined (a real miss) for a key that was never cached", async () => {
      expect(await (await store()).get("never|cached")).toBeUndefined();
    });

    it("round-trips a positive result", async () => {
      const cache = await store();
      const lines = [{ timestampMs: 0, line: "Hello" }];
      await cache.set("track|artist", lines);
      expect(await cache.get("track|artist")).toEqual(lines);
    });

    it("caches a negative result as a confirmed null", async () => {
      const cache = await store();
      await cache.set("track|artist", null);
      expect(await cache.get("track|artist")).toBeNull();
    });

    it("treats an expired negative result as a miss (undefined), not a confirmed negative", async () => {
      // Regression: a "not found" cached before a matching-logic fix (or
      // before LRCLIB's own data caught up) used to be trusted forever —
      // fixing the bug never un-cached the wrong answer it had already
      // produced.
      const cache = await store();
      await cache.set("track|artist", null);
      await backdateBy(31);
      expect(await cache.get("track|artist")).toBeUndefined();
    });

    it("still treats a recent negative result as confirmed", async () => {
      const cache = await store();
      await cache.set("track|artist", null);
      await backdateBy(29);
      expect(await cache.get("track|artist")).toBeNull();
    });

    it("set() refreshes createdAt, restarting the TTL on a re-confirmed negative", async () => {
      const cache = await store();
      await cache.set("track|artist", null);
      await backdateBy(31);
      expect(await cache.get("track|artist")).toBeUndefined();

      await cache.set("track|artist", null);
      expect(await cache.get("track|artist")).toBeNull();
    });
  });
}
