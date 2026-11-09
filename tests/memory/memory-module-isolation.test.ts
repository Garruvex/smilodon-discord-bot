import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { MemoryLookupTool } from "../../src/application/chat/tools/memory-lookup-tool.js";
import type { ChatToolContext } from "../../src/application/chat/tools/chat-tool.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import type { RepositoryIngestInput } from "../../src/application/memory/memory.js";
import { createSqliteDatabaseConnection, type SqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import * as schema from "../../src/infrastructure/database/sqlite-schema.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";

const connections: SqliteDatabaseConnection[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); });

function setup(): { connection: SqliteDatabaseConnection; repository: SqliteMemoryRepository; engine: DefaultMemoryEngine } {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "module-isolation-")));
  connections.push(connection);
  const repository = new SqliteMemoryRepository(connection.database);
  return { connection, repository, engine: new DefaultMemoryEngine(repository) };
}

function record(overrides: Partial<RepositoryIngestInput> = {}): RepositoryIngestInput {
  return {
    guildId: "guild", kind: "fact", audience: "private", ownerUserId: "alice", channelId: null,
    isolationChannelId: null, subjectType: "member", subjectId: "alice", topic: "preference", slot: "fruit",
    statement: "likes apples", status: "active", source: "live", importance: 1,
    embedding: null, embeddingModel: null, expiresAt: null, now: 1_000,
    sourceMessageId: "human", sourceChannelId: "general", assertedByUserId: "alice", ...overrides,
  };
}

const turn = { guildId: "guild", channelId: "general", userId: "alice", message: "apples", recentHistory: [], subjectIds: ["alice"], now: 2_000 };
const toolContext: ChatToolContext = {
  guildId: "guild", channelId: "general", currentUser: { id: "alice", displayName: "Alice", roleNames: [] },
  channelIsNsfw: false, channelMode: "shared", isOwner: false, music: null, pendingGeneratedImages: [],
};

describe("module memory isolation", () => {
  it("upgrades existing ordinary facts without changing their identity or recall", async () => {
    const client = new Database(":memory:");
    try {
      const migrations = readMigrationFiles({ migrationsFolder: "drizzle-sqlite" });
      for (const migration of migrations.slice(0, -1)) {
        for (const statement of migration.sql) client.exec(statement);
      }
      client.prepare(`INSERT INTO memories (id, guild_id, kind, audience, subject_type, subject_id, topic, slot,
        statement, status, source, importance, created_at, updated_at, valid_from)
        VALUES ('legacy', 'guild', 'fact', 'guild', 'member', 'alice', 'preference', 'fruit',
        'likes apples', 'active', 'live', 1, 1000, 1000, 1000)`).run();
      for (const statement of migrations.at(-1)!.sql) client.exec(statement);
      const repository = new SqliteMemoryRepository(drizzle(client, { schema }));
      expect(await repository.findById("guild", "legacy")).toMatchObject({ moduleId: null, status: "active", statement: "likes apples" });
      await repository.ingest(record({ moduleId: "relationships", audience: "guild", ownerUserId: null }));
      const result = await repository.findRecallCandidates(turn);
      expect(result.memories.map((memory) => memory.id)).toEqual(["legacy"]);
    } finally {
      client.close();
    }
  });

  it.each(["ordinary", "self-subject", "self-private"] as const)("excludes module records from %s recall while preserving listing and forgetting", async (path) => {
    const { repository, engine } = setup();
    const ordinary = await repository.ingest(record());
    const module = await repository.ingest(record({ moduleId: "relationships", slot: "tone", statement: "enjoys apple jokes" }));
    const result = await engine.recall({ ...turn, onlySelfSubjectMemories: path === "self-subject", onlySelfPrivateMemories: path === "self-private" });
    expect(result.memories.map((memory) => memory.id)).toEqual([ordinary.id]);
    expect((await engine.listUserMemories("guild", "alice", "general")).map((memory) => memory.id)).toContain(module.id);
    expect(await engine.forget({ guildId: "guild", ownerUserId: "alice", channelId: "general", memoryId: module.id })).toBe(1);
    expect(await repository.findById("guild", module.id)).toBeNull();
    expect(await repository.findById("guild", ordinary.id)).not.toBeNull();
  });

  it.each(["search", "list"] as const)("keeps retained module data out of lookup_memory %s", async (scope) => {
    const { repository, engine } = setup();
    await repository.ingest(record({ moduleId: "relationships", statement: "enjoys secret apple jokes" }));
    const result = await new MemoryLookupTool(engine).execute({ scope, query: "apples" }, toolContext);
    expect(result.content).toBe("No matching memories or guild knowledge found.");
    expect(await engine.listUserMemories("guild", "alice", "general")).toHaveLength(1);
  });

  it("filters module records before the repository candidate cap", async () => {
    const { connection, repository, engine } = setup();
    const ordinary = await repository.ingest(record({ audience: "guild", ownerUserId: null }));
    // More recent module records must not crowd the old ordinary fact out
    // of the 2,000-row SQL cap before it can be ranked.
    connection.database.transaction((transaction) => {
      for (let index = 0; index < 2_001; index++) {
        transaction.insert(schema.memories).values({
          id: `module-${index}`, guildId: "guild", moduleId: "relationships", kind: "fact", audience: "guild",
          subjectType: "member", subjectId: "alice", topic: "relationship", slot: `topic.${index}`,
          statement: "enjoys apple jokes", status: "active", source: "consolidation", importance: 3,
          createdAt: new Date(1_500), updatedAt: new Date(1_500), validFrom: new Date(1_500),
        }).run();
      }
    });
    expect((await engine.recall(turn)).memories.map((memory) => memory.id)).toEqual([ordinary.id]);
  });
});
