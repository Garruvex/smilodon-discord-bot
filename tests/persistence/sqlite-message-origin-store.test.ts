import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMessageOriginStore } from "../../src/infrastructure/persistence/sqlite-message-origin-store.js";

describe("message origins", () => {
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
      expect(await store.find("g", "c", "m1")).toEqual(input);
      expect(await store.find("other", "c", "m1")).toBeNull();
      expect(await store.find("g", "other", "m1")).toBeNull();
    } finally { reopened.close(); }
  });
});
