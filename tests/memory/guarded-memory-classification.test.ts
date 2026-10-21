import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { memoryClaimPayload } from "../../src/application/memory/memory-claim-provenance.js";
import type { RepositoryIngestInput } from "../../src/application/memory/memory.js";
import type { MemoryConflictClassifier } from "../../src/application/chat/chat-provider.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

describe("guarded memory conflict processing", () => {
  it("keeps both authorized witnesses in the manifest after corroboration merges their rows", async () => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-witnesses-"))); cleanup.push(() => connection.close());
    const repository = new SqliteMemoryRepository(connection.database); const engine = new DefaultMemoryEngine(repository, null, null, undefined, null, null, null, () => true);
    const fixture = guardedFixture(guardedEvent("bob-source", 1000, "Alice likes apples", "bob"));
    fixture.actors.set("bob", { id: "bob", displayName: "bob", roleNames: [] }); fixture.actors.set("carol", { id: "carol", displayName: "carol", roleNames: [] });
    const ingest = async (actor: string, sourceId: string, now: number): ReturnType<DefaultMemoryEngine["ingest"]> => {
      fixture.port.actorId = actor; fixture.port.sourceMessageId = sourceId;
      const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 4000, burstIds: [] });
      return engine.ingest({ guildId: "guild", channelId: "channel", channelMode: "shared", assertedByUserId: actor, sourceMessageId: sourceId, source: "live", now, context,
        proposals: [{ action: "upsert", kind: "preference", audience: "guild", ownerUserId: null, channelScoped: true,
          subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit", statement: "likes apples" }] });
    };
    const first = await ingest("bob", "bob-source", 2000); expect(first.ingested[0]?.status).toBe("candidate");
    fixture.add(guardedEvent("carol-source", 3000, "Alice likes apples", "carol"));
    const second = await ingest("carol", "carol-source", 4000); const active = second.ingested[0]!;
    expect(active.status).toBe("active");
    expect(active.contextProvenance?.dependencies.map((source) => source.messageId).sort()).toEqual(["bob-source", "carol-source"]);
    fixture.denied.add("bob-source");
    const next = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 4000, burstIds: [] });
    expect(await next.memories([active], false, 5000)).toEqual([]);
  });
  it.each(["verified", "legacy", "revoked", "changed_during_classification"] as const)("authorizes old claims before classification and supersession: %s", async (scenario) => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-classification-"))); cleanup.push(() => connection.close());
    const repository = new SqliteMemoryRepository(connection.database);
    const fixture = guardedFixture(guardedEvent("old", 1000, "I prefer apples"));
    const original = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 4000, burstIds: [] });
    const old: RepositoryIngestInput = { guildId: "guild", audience: "channel", ownerUserId: null, channelId: "channel", isolationChannelId: null,
      kind: "preference", subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit.old", statement: "prefers apples", status: "active", source: "live",
      embedding: [1, 0], embeddingModel: "test", importance: 1, expiresAt: null, now: 1000, assertedByUserId: "alice", sourceMessageId: "old", sourceChannelId: "channel" };
    const stored = await repository.ingest({ ...old, ...(scenario === "legacy" ? {} : { contextProvenance: original.provenance(memoryClaimPayload(old), "memory_claim") }) });
    fixture.add(guardedEvent("current", 4000, "I now prefer oranges")); fixture.port.sourceMessageId = "current";
    if (scenario === "revoked") fixture.denied.add("old");
    const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 4000, burstIds: [] });
    const classifyMemoryConflict = vi.fn<MemoryConflictClassifier["classifyMemoryConflict"]>().mockImplementation(async (_old, _next, options) => {
      await options?.beforeAttempt?.();
      if (scenario === "changed_during_classification") fixture.denied.add("old");
      return true;
    });
    const engine = new DefaultMemoryEngine(repository, { modelId: "test", embed: (): Promise<number[]> => Promise.resolve([0.8, 0.6]) }, null, undefined,
      { classifyMemoryConflict }, null, null, () => true);
    await engine.ingest({ guildId: "guild", channelId: "channel", channelMode: "shared", assertedByUserId: "alice", sourceMessageId: "current", source: "live", now: 5000,
      context, proposals: [{ action: "upsert", kind: "preference", audience: "guild", ownerUserId: null, channelScoped: true,
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit.new", statement: "prefers oranges" }] });
    expect(classifyMemoryConflict).toHaveBeenCalledTimes(scenario === "verified" || scenario === "changed_during_classification" ? 1 : 0);
    expect((await repository.findById("guild", stored.id))?.status).toBe(scenario === "verified" ? "superseded" : "active");
  });
});
