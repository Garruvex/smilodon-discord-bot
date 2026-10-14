import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import type { ChannelMemoryMode } from "../../src/application/memory/memory-channel-policy.js";

describe("public preference lifecycle", () => {
  it("keeps personal facts private until explicitly activated, including model-claimed guild facts", async () => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "sharing-activation-")));
    try {
      let enabled = false;
      const engine = new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database), null, null, undefined, null, null, null, () => enabled);
      const base = { guildId: "g", channelId: "staff", channelMode: "shared" as const, assertedByUserId: "bob", sourceMessageId: "m", source: "live" as const, now: 100 };
      const proposal = { action: "upsert" as const, audience: "guild" as const, kind: "preference" as const, ownerUserId: null,
        subjectType: "member" as const, subjectId: "bob", topic: "preference", slot: "food", statement: "likes apples", channelScoped: false };
      expect((await engine.ingest({ ...base, proposals: [proposal] })).ingested[0]).toMatchObject({ audience: "private", ownerUserId: "bob" });
      enabled = true;
      expect((await engine.ingest({ ...base, proposals: [{ ...proposal, slot: "color", statement: "likes green" }] })).ingested[0]).toMatchObject({ audience: "guild", ownerUserId: null });
      const old = await engine.listUserMemories("g", "bob", "staff");
      expect(old.find((memory) => memory.slot === "food")?.audience).toBe("private");
    } finally { connection.close(); }
  });
  it.each(["shared", "isolated"] as const)("retains subject, evidence, correction, scope and authorized deletion (%s)", async (mode: ChannelMemoryMode) => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "shared-lifecycle-")));
    try {
      const repo = new SqliteMemoryRepository(connection.database);
      const engine = new DefaultMemoryEngine(repo, null, null, undefined, null, null, null, () => true);
      const base = { guildId: "guild", channelId: "source", channelMode: mode, assertedByUserId: "bob", source: "live" as const };
      const proposal = { action: "upsert" as const, audience: "private" as const, kind: "preference" as const, ownerUserId: "bob",
        subjectType: "member" as const, subjectId: "bob", topic: "preference", slot: "food.fruit", statement: "likes apples", channelScoped: false,
        sourceQuote: "I like apples" };
      const written = await engine.ingest({ ...base, sourceMessageId: "original", now: 100, proposals: [proposal] });
      const fact = written.ingested[0]!;
      expect(fact).toMatchObject({ ownerUserId: null, subjectId: "bob", audience: mode === "shared" ? "guild" : "channel" });
      const recall = (channelId: string): ReturnType<DefaultMemoryEngine["recall"]> => engine.recall({ guildId: "guild", channelId, userId: "alice", message: "bob apples",
        recentHistory: [], subjectIds: ["bob"], now: 200, channelMode: "shared" });
      expect((await recall("source")).memories.map((memory) => memory.id)).toContain(fact.id);
      expect((await recall("other")).memories.map((memory) => memory.id).includes(fact.id)).toBe(mode === "shared");
      expect(await engine.listSources(fact.id)).toMatchObject([{ sourceMessageId: "original", assertedByUserId: "bob",
        sourceQuote: "I like apples", sourceChannelMode: mode }]);
      expect(await engine.listUserMemories("guild", "bob", "source")).toHaveLength(1);
      expect(await engine.forget({ guildId: "guild", ownerUserId: "alice", memoryId: fact.id, channelId: "source" })).toBe(0);
      const summary = { ...proposal, kind: "episode" as const, topic: "scene_summary", slot: "scene.fruit",
        statement: "Bob discussed apples", supportingSources: [{ subjectId: "bob", messageId: "correction", timestampMs: 300 }] };
      await engine.ingest({ ...base, sourceMessageId: "correction", now: 300, proposals: [summary] });
      await engine.ingest({ ...base, sourceMessageId: "correction", now: 300, proposals: [{ ...proposal,
        statement: "does not like apples anymore", sourceQuote: "I do not like apples anymore" }] });
      const current = await engine.listUserMemories("guild", "bob", "source");
      expect(current).toHaveLength(2);
      expect(current.find((memory) => memory.topic === "preference")!.statement).toBe("does not like apples anymore");
      const removed = await engine.ingest({ ...base, sourceMessageId: "forget", now: 400, proposals: [{
        action: "remove", ownerUserId: "bob", subjectType: "member", subjectId: "bob", topic: " PREFERENCE ", slot: " FOOD.FRUIT ",
      }] });
      expect(removed.removed).toBeGreaterThan(0);
      expect(await engine.listUserMemories("guild", "bob", "source")).toEqual([]);
      expect(await repo.findById("guild", fact.id)).toBeNull();
      const replay = await engine.ingest({ ...base, sourceMessageId: "original", sourceTimestampMs: 100,
        now: Date.now(), proposals: [proposal] });
      expect(replay).toMatchObject({ ingested: [], rejected: 1 });
      expect(await engine.ingest({ ...base, sourceMessageId: "correction", sourceTimestampMs: 300,
        now: Date.now(), proposals: [summary] })).toMatchObject({ ingested: [], rejected: 1 });
      const fresh = await engine.ingest({ ...base, sourceMessageId: "new-human-statement", sourceTimestampMs: Date.now() + 1000,
        now: Date.now() + 1000, proposals: [proposal] });
      expect(fresh.ingested).toHaveLength(1);
    } finally { connection.close(); }
  });
});
