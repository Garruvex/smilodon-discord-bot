import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { planPublicMemoryBackfill } from "../../src/application/memory/public-memory-backfill.js";

describe("reviewed public-memory migration", () => {
  it("dry-runs without changing scope, verifies original humans, preserves isolation, and applies idempotently", async () => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "public-backfill-")));
    try {
      const repository = new SqliteMemoryRepository(connection.database);
      const memory = await repository.ingest({ guildId: "g", kind: "preference", audience: "private", ownerUserId: "bob",
        channelId: null, isolationChannelId: "c", subjectType: "member", subjectId: "bob", topic: "preference", slot: "food.fruit",
        statement: "likes apples", status: "active", source: "live", importance: 1, embedding: null, embeddingModel: null,
        expiresAt: null, now: 1, sourceMessageId: "m", sourceChannelId: "c", assertedByUserId: "bob" });
      const reviewed = { guildId: "g", memoryId: memory.id, sourceMessageId: "m", sourceChannelId: "c",
        historicalMode: "shared" as const, sourceQuote: "I like apples", approved: true as const };
      const original = { guildId: "g", channelId: "c", messageId: "m", authorId: "bob", authorIsBot: false, content: "I like apples", timestampMs: 1 };
      expect((await planPublicMemoryBackfill(repository, reviewed, null, "shared")).eligible).toBe(false);
      expect((await planPublicMemoryBackfill(repository, reviewed, { ...original, authorIsBot: true }, "shared")).eligible).toBe(false);
      expect((await planPublicMemoryBackfill(repository, reviewed, original, "disabled")).eligible).toBe(false);
      const plan = await planPublicMemoryBackfill(repository, reviewed, original, "shared");
      expect((await repository.findById("g", memory.id))?.audience).toBe("private");
      expect(plan.eligible).toBe(true);
      if (!plan.eligible) throw new Error("Expected a reviewed migration plan");
      expect(plan.scope).toMatchObject({ audience: "channel", isolationChannelId: "c" });
      expect(await repository.reclassifyPublicMemory(plan.command)).toBe(true);
      expect(await repository.reclassifyPublicMemory(plan.command)).toBe(false);
      expect((await planPublicMemoryBackfill(repository, reviewed, original, "shared")).reason).toBe("already_shared_or_not_private");
    } finally { connection.close(); }
  });
});
