import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMessageOriginStore } from "../../src/infrastructure/persistence/sqlite-message-origin-store.js";
import { captureIncompleteTurnProvenance } from "../../src/application/chat/context-provenance.js";
import { decisionRequest } from "../helpers/conversation-decision-fixtures.js";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

describe("message origins", () => {
  it("upgrades an existing database without manufacturing provenance for old output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "origin-provenance-upgrade-"));
    const olderMigrations = join(directory, "older-migrations"); mkdirSync(join(olderMigrations, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync("drizzle-sqlite/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.slice(0, -1);
    for (const entry of journal.entries) copyFileSync(`drizzle-sqlite/${entry.tag}.sql`, join(olderMigrations, `${entry.tag}.sql`));
    writeFileSync(join(olderMigrations, "meta", "_journal.json"), JSON.stringify(journal));
    const client = new Database(join(directory, "chat.sqlite"));
    try {
      migrate(drizzle(client), { migrationsFolder: olderMigrations });
      client.prepare("INSERT INTO message_origins (message_id, guild_id, channel_id, origin, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("old", "guild", "channel", "chat", 1);
    } finally { client.close(); }
    const upgraded = createSqliteDatabaseConnection(directory);
    try {
      expect(await new SqliteMessageOriginStore(upgraded.database).find("guild", "channel", "old"))
        .toMatchObject({ messageId: "old", origin: "chat", contextProvenance: null });
    } finally { upgraded.close(); }
  });

  it("persists bounded dependency metadata through restart and rejects a mismatched audience", async () => {
    const directory = mkdtempSync(join(tmpdir(), "origin-provenance-restart-"));
    const proof = captureIncompleteTurnProvenance(decisionRequest(), "answer")!;
    const record = { messageId: "new", guildId: "guild", channelId: "channel", origin: "chat" as const, sourceMessageId: "current", createdAt: 1, contextProvenance: proof };
    const first = createSqliteDatabaseConnection(directory);
    try {
      const store = new SqliteMessageOriginStore(first.database);
      await store.record(record);
      await store.record({ ...record, messageId: "wrong-scope", channelId: "private" });
    } finally { first.close(); }
    const reopened = createSqliteDatabaseConnection(directory);
    try {
      const store = new SqliteMessageOriginStore(reopened.database);
      expect(await store.find("guild", "channel", "new")).toEqual(record);
      expect((await store.find("guild", "private", "wrong-scope"))?.contextProvenance).toBeNull();
    } finally { reopened.close(); }
  });
  it("survives restart, respects scope, and cannot overwrite a utility origin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "message-origins-"));
    const input = { messageId: "m1", guildId: "g", channelId: "c", origin: "link_fix" as const, sourceMessageId: "human", createdAt: 123 };
    const first = createSqliteDatabaseConnection(directory);
    try {
      const store = new SqliteMessageOriginStore(first.database);
      await store.record(input);
      await store.record({ ...input, origin: "chat" });
    } finally { first.close(); }
    const reopened = createSqliteDatabaseConnection(directory);
    try {
      const store = new SqliteMessageOriginStore(reopened.database);
      expect(await store.find("g", "c", "m1")).toEqual({ ...input, contextProvenance: null });
      expect(await store.find("other", "c", "m1")).toBeNull();
      expect(await store.find("g", "other", "m1")).toBeNull();
    } finally { reopened.close(); }
  });
});
