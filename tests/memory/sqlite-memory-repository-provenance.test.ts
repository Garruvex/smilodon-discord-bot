import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import * as schema from "../../src/infrastructure/database/sqlite-schema.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import type { RepositoryIngestInput } from "../../src/application/memory/memory.js";

function ingestInput(overrides: Partial<RepositoryIngestInput> = {}): RepositoryIngestInput {
  return {
    guildId: "guild", kind: "fact", audience: "guild", ownerUserId: null, channelId: "channel",
    isolationChannelId: null, subjectType: "guild", subjectId: "guild", topic: "community_activity", slot: "raid.friday",
    statement: "organizes raids", status: "active", source: "consolidation", confidence: 1, importance: 1,
    embedding: null, embeddingModel: null, expiresAt: null, now: 1_000,
    sourceMessageId: "batch:scan:guild:channel:m10-m1", sourceChannelId: "channel", assertedByUserId: null,
    ...overrides,
  };
}

describe("SqliteMemoryRepository — idempotent batch provenance", () => {
  it("retrying the same batch id does not insert a duplicate memory_sources row", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sqlite-memory-provenance-"));
    const connection = createSqliteDatabaseConnection(directory);
    const repository = new SqliteMemoryRepository(connection.database);

    const first = await repository.ingest(ingestInput({ now: 1_000 }));
    // Simulates a scheduler retry of the exact same batch after a partial
    // failure — same batchId (sourceMessageId), same identity/statement.
    await repository.ingest(ingestInput({ now: 2_000 }));

    const sources = connection.database.select().from(schema.memorySources)
      .where(eq(schema.memorySources.memoryId, first.id)).all();
    expect(sources).toHaveLength(1);
  });

  it("a different batch id for the same memory still records separate provenance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sqlite-memory-provenance-"));
    const connection = createSqliteDatabaseConnection(directory);
    const repository = new SqliteMemoryRepository(connection.database);

    const first = await repository.ingest(ingestInput({ sourceMessageId: "batch:scan:guild:channel:m10-m1", now: 1_000 }));
    await repository.ingest(ingestInput({ sourceMessageId: "batch:daily:guild:channel:m20-m11", now: 2_000 }));

    const sources = connection.database.select().from(schema.memorySources)
      .where(eq(schema.memorySources.memoryId, first.id)).all();
    expect(sources).toHaveLength(2);
  });

  it("live-chat ingests (sourceMessageId null) are unaffected — always record a new source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sqlite-memory-provenance-"));
    const connection = createSqliteDatabaseConnection(directory);
    const repository = new SqliteMemoryRepository(connection.database);

    const input = ingestInput({
      audience: "private", ownerUserId: "alice", channelId: null, subjectType: "member", subjectId: "alice",
      topic: "preference", slot: "food.fruit", source: "live", sourceMessageId: null,
    });
    const first = await repository.ingest({ ...input, now: 1_000 });
    await repository.ingest({ ...input, now: 2_000 });

    const sources = connection.database.select().from(schema.memorySources)
      .where(eq(schema.memorySources.memoryId, first.id)).all();
    expect(sources).toHaveLength(2);
  });
});
