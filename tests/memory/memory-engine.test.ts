import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine, defaultMemoryEngineLimits, type MemoryEngineLimits } from "../../src/application/memory/memory-engine.js";
import type { MemoryEngine } from "../../src/application/memory/memory.js";

function engine(limits?: Partial<MemoryEngineLimits>): MemoryEngine {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-memory-engine-"));
  const connection = createSqliteDatabaseConnection(directory);
  return new DefaultMemoryEngine(
    new SqliteMemoryRepository(connection.database), null, null,
    limits ? { ...defaultMemoryEngineLimits, ...limits } : undefined,
  );
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

  it("disabled channel: recall returns nothing, even for memories written elsewhere", async () => {
    const memoryEngine = engine();
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "bob", sourceMessageId: null, source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "bob",
        subjectType: "member", subjectId: "bob", topic: "preference", slot: "food.fruit",
        statement: "likes apples", channelScoped: false,
      }],
    });
    const result = await memoryEngine.recall({
      guildId: "guild", channelId: "confessional", userId: "bob", message: "apples",
      recentHistory: [], subjectIds: ["bob"], now: 200, channelMode: "disabled",
    });
    expect(result.memories).toHaveLength(0);
    expect(result.causalChains).toHaveLength(0);
  });

  it("requireTopicalMatch excludes a memory with no lexical/semantic overlap with the query, even though ordinary recall would include it on subject boost alone", async () => {
    const memoryEngine = engine();
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "bob", sourceMessageId: null, source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "bob",
        subjectType: "member", subjectId: "bob", topic: "preference", slot: "food.fruit",
        statement: "likes green apples", channelScoped: false,
      }],
    });
    // No embeddings client configured, so there's no semantic signal either
    // — a query sharing no words with the stored statement should be
    // excluded under requireTopicalMatch despite recall's subject boost
    // otherwise making it eligible (see the plain recall below).
    const gated = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "bob", message: "what's the weather like",
      recentHistory: [], subjectIds: ["bob"], now: 200, requireTopicalMatch: true,
    });
    expect(gated.memories).toHaveLength(0);
    const ungated = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "bob", message: "what's the weather like",
      recentHistory: [], subjectIds: ["bob"], now: 200,
    });
    expect(ungated.memories).toHaveLength(1);
    const matching = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "bob", message: "what fruit do I like",
      recentHistory: [], subjectIds: ["bob"], now: 200, requireTopicalMatch: true,
    });
    expect(matching.memories).toHaveLength(1);
  });

  it("onlySelfPrivateMemories narrows the candidate set before budgeting, so higher-ranked ineligible memories can't crowd out the caller's own", async () => {
    const memoryEngine = engine({ maxSelectedChars: 900 });
    // Ingested older, so it loses the recency tie-breaker against the
    // guild memories below — deliberately handing them the ranking
    // advantage, so an unnarrowed recall gives its small budget to them
    // first if nothing stopped it from considering them at all.
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "bob", sourceMessageId: null, source: "live", now: 50,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "bob",
        subjectType: "member", subjectId: "bob", topic: "preference", slot: "food.fruit",
        statement: "likes green apples", channelScoped: false,
      }],
    });
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "bob", sourceMessageId: null, source: "live", now: 150,
      proposals: Array.from({ length: 5 }, (_unused, i) => ({
        action: "upsert" as const, audience: "guild" as const, kind: "fact" as const, ownerUserId: null,
        subjectType: "member" as const, subjectId: "bob", topic: "activity", slot: `raid.${i}`,
        statement: `bob organized raid number ${i} with a fairly long description to eat budget`, channelScoped: false,
      })),
    });
    const narrowed = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "bob", message: "",
      recentHistory: [], subjectIds: ["bob"], now: 200, onlySelfPrivateMemories: true,
    });
    expect(narrowed.memories).toMatchObject([{ audience: "private", statement: "likes green apples" }]);
    // Without the narrowing, the same small budget goes entirely to the
    // more-recent guild memories instead — proving the crowding-out this
    // option exists to prevent is real, not hypothetical.
    const unnarrowed = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "bob", message: "",
      recentHistory: [], subjectIds: ["bob"], now: 200,
    });
    expect(unnarrowed.memories.length).toBeGreaterThan(0);
    expect(unnarrowed.memories.some((memory) => memory.audience === "private")).toBe(false);
  });

  it("onlySelfPrivateMemories still finds the caller's own memory when the guild has enough other memories to fill findRecallCandidates' own row cap", async () => {
    // findRecallCandidates (see the repository) bounds its SQL query at
    // maxEligibleCandidates (2,000) with no ORDER BY guaranteeing the
    // caller's own rows survive the cutoff — a guild busy enough to hit
    // that cap could crowd bob's own private memory out of the candidate
    // set entirely, before onlySelfPrivateMemories (or requireTopicalMatch,
    // or the character budget) ever gets a chance to filter anything. This
    // proves the fix bypasses that shared, capped query for onlySelfPrivateMemories
    // rather than filtering its output.
    const memoryEngine = engine();
    // subjectType "guild" (not "member") so each one self-activates as
    // "active" immediately under consolidation (see resolveInitialStatus) —
    // findRecallCandidates only selects active rows, so a "candidate" fact
    // wouldn't actually occupy a slot in its row cap.
    const otherGuildMemories = Array.from({ length: 2_000 }, (_unused, i) => ({
      action: "upsert" as const, audience: "guild" as const, kind: "fact" as const, ownerUserId: null,
      subjectType: "guild" as const, subjectId: "guild", topic: "activity", slot: `fact.${i}`,
      statement: `fact number ${i}`, channelScoped: false,
    }));
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: null, sourceMessageId: null, source: "consolidation", now: 100,
      proposals: otherGuildMemories,
    });
    // Inserted after the 2,000 above, so a naive LIMIT-2,000-no-ORDER-BY
    // scan (what findRecallCandidates does) would not reach it.
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "bob", sourceMessageId: null, source: "live", now: 150,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "bob",
        subjectType: "member", subjectId: "bob", topic: "preference", slot: "food.fruit",
        statement: "likes green apples", channelScoped: false,
      }],
    });

    const narrowed = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "bob", message: "",
      recentHistory: [], subjectIds: ["bob"], now: 200, onlySelfPrivateMemories: true,
    });
    expect(narrowed.memories).toMatchObject([{ audience: "private", statement: "likes green apples" }]);
  }, 20_000);
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

  it("a consolidation-sourced member-subject fact with no self-report evidence starts as a candidate, not active", async () => {
    // Regression for the trust loophole: consolidation used to blanket-
    // activate every proposal (source === "consolidation" short-circuited
    // before the subject/asserter check), so a third-party claim about a
    // member — captured verbatim from a channel summary — would become
    // durable, active guild knowledge without the subject ever confirming
    // it. See memory-engine.ts's resolveInitialStatus consolidation branch.
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: null, sourceMessageId: "batch:daily:guild:general:x-y", source: "consolidation", now: 100,
      proposals: [{
        action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
        subjectType: "member", subjectId: "alice", topic: "activity", slot: "raid.friday",
        statement: "alice organizes Friday raids", channelScoped: false,
      }],
    });
    expect(result.ingested[0]!.status).toBe("candidate");
  });

  it("a consolidation-sourced member-subject fact self-activates when the proposal's own assertedByUserId names the subject", async () => {
    // ChannelSummaryScheduler resolves this per-fact from evidence (the
    // subject's own message among the batch) and sets it on the proposal —
    // the ingest-level assertedByUserId stays null (no single batch asserter).
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: null, sourceMessageId: "batch:daily:guild:general:x-y", source: "consolidation", now: 100,
      proposals: [{
        action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
        subjectType: "member", subjectId: "alice", topic: "activity", slot: "raid.friday",
        statement: "alice organizes Friday raids", channelScoped: false,
        assertedByUserId: "alice",
      }],
    });
    expect(result.ingested[0]!.status).toBe("active");
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
