import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteConversationEpisodeStore } from "../../src/infrastructure/persistence/sqlite-conversation-episode-store.js";

describe("persisted bounded conversation episodes", () => {
  it("retains an explicitly extended window across restart and falls back to legacy retention when disabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conversation-extended-")); const now = Date.now();
    const first = createSqliteDatabaseConnection(directory); const store = new SqliteConversationEpisodeStore(first.database);
    await store.observe("g", "c", { messageId: "18-minutes-ago", timestampMs: now - 18 * 60_000, authorId: "alice", authorDisplayName: "Alice", content: "earlier", imageCount: 0 }, now, 20 * 60_000);
    first.close(); const reopened = createSqliteDatabaseConnection(directory);
    try {
      const again = new SqliteConversationEpisodeStore(reopened.database);
      expect((await again.load("g", "c", now)).map((event) => event.messageId)).toEqual(["18-minutes-ago"]);
      await again.observe("g", "c", { messageId: "latest", timestampMs: now, authorId: "bob", authorDisplayName: "Bob", content: "new", imageCount: 0 }, now);
      expect((await again.load("g", "c", now)).map((event) => event.messageId)).toEqual(["latest"]);
    } finally { reopened.close(); }
  });
  it("preserves shared context across restart, prunes old events, and removes utility reply branches", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conversation-episodes-"));
    const now = Date.now();
    const first = createSqliteDatabaseConnection(directory);
    const store = new SqliteConversationEpisodeStore(first.database);
    const events = [
      { messageId: "old", timestampMs: now - 1_000_000, authorId: "alice", authorDisplayName: "Alice", content: "old", imageCount: 0 },
      { messageId: "utility", timestampMs: now - 300, authorId: "alice", authorDisplayName: "Alice", content: "link", imageCount: 0 },
      { messageId: "reply", timestampMs: now - 200, authorId: "bob", authorDisplayName: "Bob", content: "about link", imageCount: 0, replyToMessageId: "utility" },
      { messageId: "new-topic", timestampMs: now - 100, authorId: "bob", authorDisplayName: "Bob", content: "different topic", imageCount: 0 },
    ];
    await Promise.all(events.map((event) => store.observe("g", "c", event, now)));
    await store.exclude("g", "c", "utility");
    first.close();
    const reopened = createSqliteDatabaseConnection(directory);
    try {
      const again = new SqliteConversationEpisodeStore(reopened.database);
      expect((await again.load("g", "c", now)).map((event) => event.messageId)).toEqual(["new-topic"]);
      expect(await again.load("other", "c", now)).toEqual([]);
      await again.forgetUser("g", "bob");
      expect(await again.load("g", "c", now)).toEqual([]);
      await again.deleteExpired(now + 1_000_000);
      expect(await again.load("g", "c", now + 1_000_000)).toEqual([]);
    } finally { reopened.close(); }
  });
});
