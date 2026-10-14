import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { groupObservedAliasRows } from "../../src/application/memory/observed-subject-names.js";

describe("source-backed observed names", () => {
  it("does not resolve a two-character Han name inside a longer compound", () => {
    const aliases = [{ alias: "苹果", subjectId: "member" }];
    expect(groupObservedAliasRows(aliases, "我买了苹果汁")).toEqual([]);
    expect(groupObservedAliasRows(aliases, "苹果，喜欢什么？")).toEqual([{ alias: "苹果", subjectIds: ["member"] }]);
  });
  it("preserves changed labels by account ID and reports collisions without merging subjects", async () => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "observed-names-")));
    try {
      const repo = new SqliteMemoryRepository(connection.database);
      const engine = new DefaultMemoryEngine(repo, null, null, undefined, null, null, null, () => true);
      const remember = (userId: string, name: string, now: number): ReturnType<DefaultMemoryEngine["ingest"]> => engine.ingest({
        guildId: "g", channelId: "c", channelMode: "shared", assertedByUserId: userId, sourceMessageId: `m-${now}`, source: "live", now,
        proposals: [{ action: "upsert", audience: "private", kind: "preference", ownerUserId: userId, subjectType: "member",
          subjectId: userId, topic: "preference", slot: "food.fruit", statement: "likes apples", channelScoped: false, observedSubjectNames: [name] }],
      });
      await remember("bob", "OldBob", 100);
      await remember("bob", "NewBob", 200);
      const query = { guildId: "g", channelId: "other", userId: "alice", message: "OldBob likes apples?", recentHistory: [], subjectIds: [], now: 300 };
      expect((await engine.recall(query)).aliasCandidates).toEqual([{ alias: "oldbob", subjectIds: ["bob"] }]);
      await remember("another-account", "OldBob", 250);
      const collision = await engine.recall(query);
      expect([...(collision.aliasCandidates?.[0]?.subjectIds ?? [])].sort()).toEqual(["another-account", "bob"]);
      expect(collision.memories.map((memory) => memory.subjectId).sort()).toEqual(["another-account", "bob"]);
    } finally { connection.close(); }
  });
});
