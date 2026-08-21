import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import type { MemoryEngine } from "../../src/application/memory/memory.js";

function engine(): MemoryEngine {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-memory-engine-"));
  const connection = createSqliteDatabaseConnection(directory);
  return new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database));
}

describe("DefaultMemoryEngine.ingest — channel-mode enforcement", () => {
  it("disabled channel: no durable writes", async () => {
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "dnd", channelMode: "disabled",
      assertedByUserId: "alice", sourceMessageId: "msg1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit",
        statement: "likes apples", channelScoped: false,
      }],
    });
    expect(result.ingested).toHaveLength(0);
    expect(await memoryEngine.listUserMemories("guild", "alice")).toHaveLength(0);
  });

  it("session_only channel: no durable writes", async () => {
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "dnd", channelMode: "session_only",
      assertedByUserId: "alice", sourceMessageId: null, source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit",
        statement: "likes apples", channelScoped: false,
      }],
    });
    expect(result.ingested).toHaveLength(0);
  });

  it("isolated channel: a model-claimed guild-wide candidate is force-scoped to the channel, never guild", async () => {
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "dnd", channelMode: "isolated",
      assertedByUserId: "bob", sourceMessageId: "msg1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
        subjectType: "member", subjectId: "alice", topic: "activity", slot: "tavern.visited",
        statement: "visited the tavern", channelScoped: false, // model claims guild-wide
      }],
    });
    expect(result.ingested).toHaveLength(1);
    const stored = result.ingested[0]!;
    expect(stored.audience).not.toBe("guild");
    expect(stored.isolationChannelId).toBe("dnd");
    expect(stored.channelId).toBe("dnd");
  });

  it("shared channel: a channelScoped=false guild candidate stays guild-wide (unchanged behavior)", async () => {
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "bob", sourceMessageId: "msg1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
        subjectType: "member", subjectId: "alice", topic: "activity", slot: "tavern.visited",
        statement: "visited the tavern", channelScoped: false,
      }],
    });
    expect(result.ingested).toHaveLength(1);
    expect(result.ingested[0]!.audience).toBe("guild");
    expect(result.ingested[0]!.isolationChannelId).toBeNull();
  });
});

describe("DefaultMemoryEngine — recall respects isolation and audience", () => {
  it("a #dnd-isolated memory is not recalled from #general", async () => {
    const memoryEngine = engine();
    // Self-reported (bob about bob) so it activates immediately — recall
    // only serves "active" memories, and a third-party claim would stay a
    // "candidate" (see resolveInitialStatus), which is a separate concern
    // from isolation and covered by the ingest tests above.
    await memoryEngine.ingest({
      guildId: "guild", channelId: "dnd", channelMode: "isolated",
      assertedByUserId: "bob", sourceMessageId: null, source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
        subjectType: "member", subjectId: "bob", topic: "activity", slot: "tavern.visited",
        statement: "visited the tavern", channelScoped: false,
      }],
    });
    const inDnd = await memoryEngine.recall({
      guildId: "guild", channelId: "dnd", userId: "bob", message: "tavern",
      recentHistory: [], subjectIds: ["bob"], now: 200,
    });
    expect(inDnd.memories).toHaveLength(1);
    const inGeneral = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "bob", message: "tavern",
      recentHistory: [], subjectIds: ["bob"], now: 200,
    });
    expect(inGeneral.memories).toHaveLength(0);
  });
});

describe("DefaultMemoryEngine.ingest — consolidation self-activates", () => {
  it("a consolidation-sourced proposal (assertedByUserId: null) is immediately recallable, not stuck as a candidate", async () => {
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: null, sourceMessageId: null, source: "consolidation", now: 100,
      proposals: [{
        action: "upsert", audience: "guild", kind: "episode", ownerUserId: null,
        subjectType: "guild", subjectId: "guild", topic: "scene_summary", slot: "scene.discovery",
        statement: "the party found a hidden door", channelScoped: true,
      }],
    });
    expect(result.ingested).toHaveLength(1);
    expect(result.ingested[0]!.status).toBe("active");
    const recalled = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "anyone", message: "hidden door",
      recentHistory: [], subjectIds: [], now: 200,
    });
    expect(recalled.memories).toHaveLength(1);
  });

  it("a live third-party claim (assertedByUserId set, not the subject) still starts as a candidate", async () => {
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "bob", sourceMessageId: null, source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
        subjectType: "member", subjectId: "alice", topic: "activity", slot: "raid.friday",
        statement: "alice organizes Friday raids", channelScoped: false,
      }],
    });
    expect(result.ingested[0]!.status).toBe("candidate");
  });
});

describe("DefaultMemoryEngine.forget", () => {
  it("removes a memory by id, scoped to the guild", async () => {
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: null, source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit",
        statement: "likes apples", channelScoped: false,
      }],
    });
    const memoryId = result.ingested[0]!.id;
    const removedCount = await memoryEngine.forget({ guildId: "guild", ownerUserId: "alice", memoryId });
    expect(removedCount).toBe(1);
    expect(await memoryEngine.listUserMemories("guild", "alice")).toHaveLength(0);
  });
});
