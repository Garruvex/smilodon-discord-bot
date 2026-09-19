import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMessageReactionWatchStore } from "../../src/infrastructure/persistence/sqlite-message-reaction-watch-store.js";

function store(): SqliteMessageReactionWatchStore {
  const directory = mkdtempSync(join(tmpdir(), "reaction-watch-"));
  const connection = createSqliteDatabaseConnection(directory);
  return new SqliteMessageReactionWatchStore(connection.database);
}

describe("SqliteMessageReactionWatchStore", () => {
  it("registers a watch and leaves an already-registered one untouched (idempotent)", async () => {
    const watchStore = store();
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "m1" }, 1_000);
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "m1" }, 5_000);

    // A duplicate registration must not reset an already-armed row — arm
    // once, then "register" again, and confirm it's still pending, not
    // reset back to "watching".
    expect(await watchStore.armOnFirstReaction("m1", 2_000, 60_000)).toBe(true);
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "m1" }, 9_000);
    const [due] = await watchStore.dequeueDue(10, 2_000 + 60_000);
    expect(due?.status).toBe("pending");
    expect(due?.firstReactionAt).toBe(2_000);
  });

  it("arms a watching row to pending only on the first reaction, returning false for a non-watched or already-armed message", async () => {
    const watchStore = store();
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "m1" }, 1_000);

    expect(await watchStore.armOnFirstReaction("unknown-message", 1_100, 60_000)).toBe(false);
    expect(await watchStore.armOnFirstReaction("m1", 1_100, 60_000)).toBe(true);
    // Second reaction before evaluation: arming again is a no-op (already pending).
    expect(await watchStore.armOnFirstReaction("m1", 1_200, 60_000)).toBe(false);
  });

  it("dequeues only due rows, oldest dueAt first, and never a watching or done row", async () => {
    const watchStore = store();
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "not-armed" }, 1_000);
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "m-late" }, 1_000);
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "m-early" }, 1_000);
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "m-done" }, 1_000);
    await watchStore.armOnFirstReaction("m-late", 5_000, 100_000);
    await watchStore.armOnFirstReaction("m-early", 1_000, 10_000);
    await watchStore.armOnFirstReaction("m-done", 1_000, 10_000);
    await watchStore.markDone("m-done", 5_000);

    const due = await watchStore.dequeueDue(10, 200_000);
    expect(due.map((watch) => watch.messageId)).toEqual(["m-early", "m-late"]);
  });

  it("never re-surfaces a message once marked done", async () => {
    const watchStore = store();
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "m1" }, 1_000);
    await watchStore.armOnFirstReaction("m1", 1_000, 1_000);
    await watchStore.markDone("m1", 5_000);

    expect(await watchStore.dequeueDue(10, 999_999)).toEqual([]);
    // A later reaction can't re-arm a done row either.
    expect(await watchStore.armOnFirstReaction("m1", 10_000, 1_000)).toBe(false);
  });

  it("deletes rows past the retention cutoff regardless of status", async () => {
    const watchStore = store();
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "old-watching" }, 1_000);
    await watchStore.register({ guildId: "guild", channelId: "channel", messageId: "recent" }, 100_000);

    const deleted = await watchStore.deleteOlderThan(50_000);
    expect(deleted).toBe(1);
    expect(await watchStore.armOnFirstReaction("old-watching", 1_000, 1_000)).toBe(false);
    expect(await watchStore.armOnFirstReaction("recent", 1_000, 1_000)).toBe(true);
  });
});
