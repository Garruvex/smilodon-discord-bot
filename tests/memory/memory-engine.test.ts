import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine, defaultMemoryEngineLimits, type MemoryEngineLimits } from "../../src/application/memory/memory-engine.js";
import type { MemoryEngine, MemoryRepository, ProposedMemory } from "../../src/application/memory/memory.js";
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";

function engineWithRepository(
  limits?: Partial<MemoryEngineLimits>,
  embeddingsClient?: EmbeddingsClient,
): { memoryEngine: MemoryEngine; repository: MemoryRepository } {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-memory-engine-"));
  const connection = createSqliteDatabaseConnection(directory);
  const repository = new SqliteMemoryRepository(connection.database);
  const memoryEngine = new DefaultMemoryEngine(
    repository, embeddingsClient ?? null, null,
    limits ? { ...defaultMemoryEngineLimits, ...limits } : undefined,
  );
  return { memoryEngine, repository };
}

function engine(limits?: Partial<MemoryEngineLimits>, embeddingsClient?: EmbeddingsClient): MemoryEngine {
  return engineWithRepository(limits, embeddingsClient).memoryEngine;
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

describe("DefaultMemoryEngine.ingest — identity canonicalization prevents slot fragmentation", () => {
  // Fixed vectors keyed on content, not a real embedding model: any
  // statement mentioning "pizza" maps to the same vector (so two proposals
  // about the same fact under different model-invented slots score cosine
  // similarity 1.0 against each other), while an unrelated statement maps
  // to an orthogonal vector (similarity 0), proving canonicalization is
  // selective rather than merging everything under one subject.
  const pizzaVsChessClient: EmbeddingsClient = {
    modelId: "test-model",
    embed: (text: string): Promise<number[]> => Promise.resolve(text.includes("pizza") ? [1, 0] : [0, 1]),
  };

  it("a second proposal about the same fact under a different model-invented slot reuses the first proposal's identity instead of fragmenting", async () => {
    const memoryEngine = engine(undefined, pizzaVsChessClient);
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "m1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.pizza",
        statement: "likes pizza", channelScoped: false,
      }],
    });
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "m2", source: "live", now: 200,
      proposals: [{
        // Deliberately a DIFFERENT slot from the first proposal — same
        // underlying fact, just named differently, the way independent
        // extraction calls routinely do (see personal-memory-extraction.ts).
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.favorite",
        statement: "really loves pizza", channelScoped: false,
      }],
    });
    const memories = await memoryEngine.listUserMemories("guild", "alice");
    // One coherent identity, not two: the second proposal's own slot
    // ("food.favorite") never actually gets stored — it's rewritten onto
    // the first proposal's identity ("food.pizza") before ingest, so the
    // statement update flows through as a revision of the SAME identity
    // rather than a second, disconnected one linked only by a post-hoc
    // supersede. Asserting the surviving slot is the first proposal's own
    // is what actually distinguishes this from checkForConflicts alone —
    // that path would have left the second proposal's own slot in place.
    expect(memories).toHaveLength(1);
    expect(memories[0]!.slot).toBe("food.pizza");
    expect(memories[0]!.statement).toBe("really loves pizza");
  });

  it("does not canonicalize two genuinely unrelated facts about the same subject", async () => {
    const memoryEngine = engine(undefined, pizzaVsChessClient);
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "m1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.pizza",
        statement: "likes pizza", channelScoped: false,
      }],
    });
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "m2", source: "live", now: 200,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "activity", slot: "game.chess",
        statement: "plays chess", channelScoped: false,
      }],
    });
    const memories = await memoryEngine.listUserMemories("guild", "alice");
    expect(memories).toHaveLength(2);
    expect(memories.map((memory) => memory.slot).sort()).toEqual(["food.pizza", "game.chess"]);
  });
});

describe("DefaultMemoryEngine — importance affects recall ranking", () => {
  it("a high-importance memory outranks an otherwise-equivalent low-importance one", async () => {
    const memoryEngine = engine();
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "m1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit",
        statement: "likes apples", channelScoped: false, importance: 1,
      }],
    });
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "m2", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.vegetable",
        statement: "likes broccoli", channelScoped: false, importance: 3,
      }],
    });
    const recalled = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "alice", message: "food",
      recentHistory: [], subjectIds: ["alice"], now: 200,
    });
    // Both memories share the same subject/recency/lexical footing — the
    // only thing that should separate their rank is importance (see
    // Bm25ScoreWeights.importanceBoost in memory-relevance.ts).
    expect(recalled.memories.map((memory) => memory.slot)).toEqual(["food.vegetable", "food.fruit"]);
  });

  it("an unrated proposal (importance omitted) ranks the same as an explicit low rating, never higher", async () => {
    const memoryEngine = engine();
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "m1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit",
        statement: "likes apples", channelScoped: false,
        // importance omitted entirely — the main reply model's own
        // userMemoryActions path never sets it (see ProposedMemoryAction).
      }],
    });
    const memories = await memoryEngine.listUserMemories("guild", "alice");
    expect(memories[0]!.importance).toBe(1);
  });
});

function upsert(overrides: Partial<Extract<ProposedMemory, { action: "upsert" }>>): ProposedMemory {
  return {
    action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
    subjectType: "member", subjectId: "carol", topic: "preference", slot: "drink.tea",
    statement: "carol likes tea", channelScoped: false,
    ...overrides,
  };
}

async function ingestAs(
  memoryEngine: MemoryEngine, asserter: string, proposal: ProposedMemory, now = 100,
): Promise<Awaited<ReturnType<MemoryEngine["ingest"]>>> {
  return memoryEngine.ingest({
    guildId: "guild", channelId: "general", channelMode: "shared",
    assertedByUserId: asserter, sourceMessageId: null, source: "live", now, proposals: [proposal],
  });
}

async function recallTea(memoryEngine: MemoryEngine, now = 200): Promise<readonly string[]> {
  const { memories } = await memoryEngine.recall({
    guildId: "guild", channelId: "general", userId: "erin", message: "tea",
    recentHistory: [], subjectIds: ["erin"], now,
  });
  return memories.map((memory) => memory.statement);
}

describe("DefaultMemoryEngine — relation boost stays on the fused-score scale", () => {
  it("a memory about a related subject doesn't outrank the speaker's own strongly-matching memory", async () => {
    const memoryEngine = engine();
    await ingestAs(memoryEngine, "alice", upsert({
      audience: "private", ownerUserId: "alice", subjectId: "alice", slot: "food.fruit", statement: "likes apples",
    }));
    await ingestAs(memoryEngine, "bob", upsert({ subjectId: "bob", slot: "game.chess", statement: "plays chess" }));
    await memoryEngine.ingestRelations({
      guildId: "guild", channelId: "general", channelMode: "shared", supportingMemoryId: null, now: 100,
      proposals: [{
        fromSubjectType: "member", fromSubjectId: "alice", predicate: "allied_with", kind: "association",
        toSubjectType: "member", toSubjectId: "bob",
      }],
    });
    const { memories } = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "alice", message: "apples",
      recentHistory: [], subjectIds: ["alice"], now: 200,
    });
    expect(memories.map((memory) => memory.statement)).toEqual(["likes apples", "plays chess"]);
  });

  it("renders a causal chain in the edge's stored direction even when walked backwards", async () => {
    const memoryEngine = engine();
    await ingestAs(memoryEngine, "alice", upsert({
      audience: "private", ownerUserId: "alice", subjectId: "alice", slot: "food.fruit", statement: "likes apples",
    }));
    await memoryEngine.ingestRelations({
      guildId: "guild", channelId: "general", channelMode: "shared", supportingMemoryId: null, now: 100,
      proposals: [{
        fromSubjectType: "member", fromSubjectId: "carol", predicate: "owes", kind: "consequence",
        toSubjectType: "member", toSubjectId: "alice",
      }],
    });
    const { causalChains } = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "alice", message: "apples",
      recentHistory: [], subjectIds: ["alice"], now: 200,
    });
    expect(causalChains).toEqual([expect.objectContaining({ fromSubjectId: "carol", toSubjectId: "alice", predicate: "owes" })]);
  });

  it("re-ingesting a known relation reports it as not newly created", async () => {
    const memoryEngine = engine();
    const input = {
      guildId: "guild", channelId: "general", channelMode: "shared" as const, supportingMemoryId: null, now: 100,
      proposals: [{
        fromSubjectType: "member" as const, fromSubjectId: "alice", predicate: "allied_with" as const,
        kind: "association" as const, toSubjectType: "member" as const, toSubjectId: "bob",
      }],
    };
    expect(await memoryEngine.ingestRelations(input)).toEqual({ created: 1, rejected: 0 });
    expect(await memoryEngine.ingestRelations(input)).toEqual({ created: 0, rejected: 0 });
  });
});

describe("DefaultMemoryEngine — candidate lifecycle", () => {
  it("a third-party claim stays unrecalled until a second, independent person makes the same claim", async () => {
    const memoryEngine = engine();
    const first = await ingestAs(memoryEngine, "bob", upsert({}));
    expect(first.ingested[0]!.status).toBe("candidate");
    expect(await recallTea(memoryEngine)).toEqual([]);
    const second = await ingestAs(memoryEngine, "dave", upsert({ statement: "Carol  likes TEA" }), 150);
    expect(second.ingested[0]!.status).toBe("active");
    expect(await recallTea(memoryEngine)).toHaveLength(1);
  });

  it("the same person repeating a claim doesn't corroborate it", async () => {
    const memoryEngine = engine();
    await ingestAs(memoryEngine, "bob", upsert({}));
    const repeated = await ingestAs(memoryEngine, "bob", upsert({}), 150);
    expect(repeated.ingested[0]!.status).toBe("candidate");
  });

  it("a contradicting claim from someone else doesn't corroborate it", async () => {
    const memoryEngine = engine();
    await ingestAs(memoryEngine, "bob", upsert({}));
    const contradiction = await ingestAs(memoryEngine, "dave", upsert({ statement: "carol hates tea" }), 150);
    expect(contradiction.ingested[0]!.status).toBe("candidate");
    expect(await recallTea(memoryEngine)).toEqual([]);
  });

  it("an uncorroborated candidate expires after candidateTtlMs and is swept on a later write", async () => {
    const { memoryEngine, repository } = engineWithRepository({ candidateTtlMs: 1_000 });
    const claim = await ingestAs(memoryEngine, "bob", upsert({}), 100);
    expect(claim.ingested[0]!.expiresAt).toBe(1_100);
    await ingestAs(memoryEngine, "erin", upsert({
      audience: "private", ownerUserId: "erin", subjectId: "erin", slot: "food.fruit", statement: "likes apples",
    }), 2_000);
    expect(await repository.findById("guild", claim.ingested[0]!.id)).toBeNull();
  });
});
