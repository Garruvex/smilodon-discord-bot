import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteChannelSummaryCheckpointStore } from "../../src/infrastructure/persistence/sqlite-channel-summary-checkpoint-store.js";
import type { ChannelSummaryCheckpointStore } from "../../src/application/context/channel-summary-checkpoint-store.js";

function store(): ChannelSummaryCheckpointStore {
  const directory = mkdtempSync(join(tmpdir(), "channel-summary-checkpoint-"));
  const connection = createSqliteDatabaseConnection(directory);
  return new SqliteChannelSummaryCheckpointStore(connection.database);
}

describe("SqliteChannelSummaryCheckpointStore", () => {
  it("returns null for a channel with no checkpoint yet", async () => {
    expect(await store().get("guild", "channel")).toBeNull();
  });

  it("recordSuccess with lastMessageId only advances the scan cursor, leaves lastRunAt null", async () => {
    const checkpointStore = store();
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, lastMessageId: "msg1" });
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint).toMatchObject({ lastMessageId: "msg1", lastRunAt: null, lastError: null, lastSuccessAt: 100 });
  });

  it("recordSuccess with dailyComplete sets lastRunAt/dailyHighWaterMarkAt, leaves lastMessageId null", async () => {
    const checkpointStore = store();
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, dailyComplete: true });
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint).toMatchObject({ lastMessageId: null, lastRunAt: 100, dailyHighWaterMarkAt: 100, dailyCursor: null, lastError: null });
  });

  it("recordSuccess with dailyCursor (capped daily) leaves lastRunAt/dailyHighWaterMarkAt untouched", async () => {
    const checkpointStore = store();
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, dailyCursor: "msg5" });
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint).toMatchObject({ dailyCursor: "msg5", lastRunAt: null, dailyHighWaterMarkAt: null });
  });

  it("a channel in both scan and daily sets independently across two calls", async () => {
    const checkpointStore = store();
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, lastMessageId: "msg1" });
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 200, dailyComplete: true });
    const checkpoint = await checkpointStore.get("guild", "channel");
    // lastMessageId persists from the earlier scan call even though this
    // recordSuccess call only advanced the daily fields.
    expect(checkpoint).toMatchObject({ lastMessageId: "msg1", lastRunAt: 200, lastError: null });
  });

  it("recordError sets lastError/lastErrorCode without touching lastMessageId/lastRunAt", async () => {
    const checkpointStore = store();
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, lastMessageId: "msg1" });
    await checkpointStore.recordError("guild", "channel", "missing_view_permission", "permission denied", 200);
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint).toMatchObject({ lastMessageId: "msg1", lastError: "permission denied", lastErrorCode: "missing_view_permission" });
  });

  it("a subsequent recordSuccess clears a prior lastError/lastErrorCode", async () => {
    const checkpointStore = store();
    await checkpointStore.recordError("guild", "channel", "fetch_failed", "provider down", 100);
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 200, dailyComplete: true });
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint?.lastError).toBeNull();
    expect(checkpoint?.lastErrorCode).toBeNull();
  });

  it("checkpoints are scoped per channel", async () => {
    const checkpointStore = store();
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel-a", now: 100, lastMessageId: "msg1" });
    expect(await checkpointStore.get("guild", "channel-b")).toBeNull();
  });

  it("a capped scan run advances lastMessageId but leaves scanCompletedAt null", async () => {
    const checkpointStore = store();
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, lastMessageId: "msg1" });
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint).toMatchObject({ lastMessageId: "msg1", scanCompletedAt: null });
  });

  it("scanComplete sets scanCompletedAt, and it's never cleared by a later daily-only success", async () => {
    const checkpointStore = store();
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, lastMessageId: "msg2", scanComplete: true });
    const afterScan = await checkpointStore.get("guild", "channel");
    expect(afterScan).toMatchObject({ lastMessageId: "msg2", scanCompletedAt: 100 });

    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 200, dailyComplete: true });
    const afterDaily = await checkpointStore.get("guild", "channel");
    expect(afterDaily).toMatchObject({ lastMessageId: "msg2", scanCompletedAt: 100, lastRunAt: 200 });
  });

  it("scan completion can seed dailyHighWaterMarkAt via an explicit override", async () => {
    const checkpointStore = store();
    await checkpointStore.recordSuccess({
      guildId: "guild", channelId: "channel", now: 100, lastMessageId: "msg1", scanComplete: true, dailyHighWaterMarkAt: 100,
    });
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint).toMatchObject({ dailyHighWaterMarkAt: 100, dailyCursor: null, lastRunAt: null });
  });

  it("resetScan clears lastErrorCode along with lastMessageId/scanCompletedAt/lastError", async () => {
    const checkpointStore = store();
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: 100, lastMessageId: "msg1", scanComplete: true });
    await checkpointStore.recordError("guild", "channel", "fetch_failed", "boom", 150);
    await checkpointStore.resetScan("guild", "channel", 200);
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint).toMatchObject({ lastMessageId: null, scanCompletedAt: null, lastError: null, lastErrorCode: null });
  });
});
