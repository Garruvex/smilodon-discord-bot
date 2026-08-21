// Runs a subset of ChannelSummaryCheckpointStore's contract against a real
// Postgres instance, mirroring channel-summary-checkpoint-store.test.ts
// (which always runs against SQLite) so both backends are verified to agree
// on the same checkpoint semantics. Skipped by default — set
// MEMORY_TEST_DATABASE_URL to run it, same as
// postgres-memory-repository.contract.test.ts.
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { PostgresChannelSummaryCheckpointStore } from "../../src/infrastructure/persistence/postgres-channel-summary-checkpoint-store.js";
import * as schema from "../../src/infrastructure/database/schema.js";

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL;

if (!databaseUrl) {
  describe.skip("PostgresChannelSummaryCheckpointStore contract", () => {
    it("requires MEMORY_TEST_DATABASE_URL to run — see this file's header comment", () => {});
  });
} else {
  const client = postgres(databaseUrl, { max: 5 });
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });

  async function store(): Promise<PostgresChannelSummaryCheckpointStore> {
    await database.execute(sql`TRUNCATE TABLE channel_summary_checkpoints`);
    return new PostgresChannelSummaryCheckpointStore(database);
  }

  describe("PostgresChannelSummaryCheckpointStore contract", () => {
    it("returns null for a channel with no checkpoint yet", async () => {
      expect(await (await store()).get("guild", "channel")).toBeNull();
    });

    it("recordSuccess with lastMessageId advances the scan cursor and sets lastSuccessAt", async () => {
      const checkpointStore = await store();
      await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, lastMessageId: "msg1" });
      const checkpoint = await checkpointStore.get("guild", "channel");
      expect(checkpoint).toMatchObject({ lastMessageId: "msg1", lastRunAt: null, lastError: null, lastSuccessAt: 100 });
    });

    it("recordSuccess with dailyComplete sets lastRunAt/dailyHighWaterMarkAt and clears dailyCursor", async () => {
      const checkpointStore = await store();
      await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, dailyCursor: "msg5" });
      await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 200, dailyComplete: true });
      const checkpoint = await checkpointStore.get("guild", "channel");
      expect(checkpoint).toMatchObject({ dailyCursor: null, lastRunAt: 200, dailyHighWaterMarkAt: 200 });
    });

    it("recordError sets lastError/lastErrorCode without touching lastMessageId, and a later success clears them", async () => {
      const checkpointStore = await store();
      await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, lastMessageId: "msg1" });
      await checkpointStore.recordError("guild", "channel", "missing_view_permission", "permission denied", 200);
      const afterError = await checkpointStore.get("guild", "channel");
      expect(afterError).toMatchObject({ lastMessageId: "msg1", lastError: "permission denied", lastErrorCode: "missing_view_permission" });

      await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 300, scanComplete: true });
      const afterSuccess = await checkpointStore.get("guild", "channel");
      expect(afterSuccess?.lastError).toBeNull();
      expect(afterSuccess?.lastErrorCode).toBeNull();
    });

    it("resetScan clears scan progress but preserves daily state", async () => {
      const checkpointStore = await store();
      await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, lastMessageId: "msg1", scanComplete: true });
      await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 200, dailyComplete: true });
      await checkpointStore.resetScan("guild", "channel", 300);
      const checkpoint = await checkpointStore.get("guild", "channel");
      expect(checkpoint).toMatchObject({ lastMessageId: null, scanCompletedAt: null, lastRunAt: 200, dailyHighWaterMarkAt: 200 });
    });

    it("checkpoints are scoped per channel", async () => {
      const checkpointStore = await store();
      await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel-a", now: 100, lastMessageId: "msg1" });
      expect(await checkpointStore.get("guild", "channel-b")).toBeNull();
    });
  });
}
