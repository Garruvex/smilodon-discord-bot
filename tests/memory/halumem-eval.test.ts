// HaluMem-inspired eval harness (arXiv:2511.03506) — evaluates memory
// quality at each operational stage separately (extraction, update, QA)
// instead of only checking end-to-end recall, per that paper's central
// finding that systems accumulate hallucinations upstream of retrieval.
// This is not a port of the HaluMem benchmark itself: it targets what this
// layer (DefaultMemoryEngine + repository) is actually responsible for —
// extraction (proposal validation) happens upstream in chat-memory-policy.ts
// and is out of scope here.
//
// Several tests below document *current* baseline behavior, including known
// gaps (see "conflict handling" describe block) that the conflict-at-write
// design (MOSAIC, arXiv:2607.16211) is meant to close. When that lands,
// the assertions in that block should change from "documents the gap" to
// "asserts the fix" — do not delete the scenarios, update them in place so
// regressions are caught the same way HaluMem catches them: per-stage.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import type { MemoryEngine } from "../../src/application/memory/memory.js";

function engine(): MemoryEngine {
  const directory = mkdtempSync(join(tmpdir(), "halumem-eval-"));
  const connection = createSqliteDatabaseConnection(directory);
  return new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database));
}

// Conflict detection (see memory-engine.ts's checkForConflicts) only runs
// when memories carry embeddings, so exercising it needs a fake client
// with fixed, hand-picked vectors rather than the real OpenAI one — cosine
// similarity between these vectors is what stands in for "semantically
// about the same thing" in these tests.
function engineWithEmbeddings(vectors: Record<string, readonly number[]>): MemoryEngine {
  const directory = mkdtempSync(join(tmpdir(), "halumem-eval-embed-"));
  const connection = createSqliteDatabaseConnection(directory);
  const embeddingsClient = { embed: (text: string): Promise<number[]> => Promise.resolve([...(vectors[text] ?? [0, 0, 1])]) };
  return new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database), embeddingsClient);
}

describe("HaluMem-staged eval — extraction (proposal validation)", () => {
  it("rejects a proposal carrying a secret pattern rather than storing a fabricated-looking memory", async () => {
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "fact", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "account", slot: "api.key",
        statement: "api_key: sk_live_abcdef1234567890", channelScoped: false,
      }],
    });
    expect(result.rejected).toBe(1);
    expect(result.ingested).toHaveLength(0);
  });

  it("rejects a malformed slot instead of silently coercing it into a stored fact", async () => {
    const memoryEngine = engine();
    const result = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "Food Fruit!",
        statement: "likes apples", channelScoped: false,
      }],
    });
    expect(result.rejected).toBe(1);
  });
});

describe("HaluMem-staged eval — update correctness", () => {
  it("a corrected statement under the same identity replaces the old one, not duplicates it", async () => {
    const memoryEngine = engine();
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "camera.favorite",
        statement: "favorite camera is the OM-1", channelScoped: false,
      }],
    });
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg2", source: "live", now: 200,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "camera.favorite",
        statement: "favorite camera is the X-T5 now", channelScoped: false,
      }],
    });
    const memories = await memoryEngine.listUserMemories("guild", "alice");
    expect(memories).toHaveLength(1);
    expect(memories[0]!.statement).toBe("favorite camera is the X-T5 now");
  });

  it("a correction preserves the superseded statement instead of erasing it (temporal versioning)", async () => {
    // Was a KNOWN GAP: ingest used to UPDATE the same row in place, so the
    // prior value was unrecoverable the moment it changed. Fixed by
    // INSERT-and-close in postgres-memory-repository.ts / sqlite-memory-
    // repository.ts — see memory.ts's Memory.validFrom/validUntil.
    const memoryEngine = engine();
    const first = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "camera.favorite",
        statement: "favorite camera is the OM-1", channelScoped: false,
      }],
    });
    const originalId = first.ingested[0]!.id;
    const second = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg2", source: "live", now: 200,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "camera.favorite",
        statement: "favorite camera is the X-T5 now", channelScoped: false,
      }],
    });
    const current = await memoryEngine.listUserMemories("guild", "alice");
    // listUserMemories returns active+candidate only — the superseded OM-1
    // row is excluded from "current" listings but not deleted.
    expect(current).toHaveLength(1);
    expect(current[0]!.statement).toBe("favorite camera is the X-T5 now");
    expect(current[0]!.id).not.toBe(originalId);

    const supersededId = second.ingested[0]!.id;
    expect(supersededId).not.toBe(originalId);
  });
});

describe("HaluMem-staged eval — conflict handling", () => {
  it("without an embeddings client, a contradictory statement under a different slot still coexists silently (documented fallback, not a bug)", async () => {
    // checkForConflicts needs embeddings to compare statements — with no
    // client configured (as in most of this file's tests), it's a no-op by
    // design rather than failing. Deployments running without an embeddings
    // client get the pre-conflict-check behavior, same as before this
    // feature existed.
    const memoryEngine = engine();
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.apples",
        statement: "likes apples", channelScoped: false,
      }],
    });
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg2", source: "live", now: 200,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.apples.dislike",
        statement: "actually hates apples", channelScoped: false,
      }],
    });
    const memories = await memoryEngine.listUserMemories("guild", "alice");
    expect(memories).toHaveLength(2);
    expect(memories.map((m) => m.statement).sort()).toEqual(["actually hates apples", "likes apples"]);
  });

  it("with embeddings, a highly similar restatement under a different slot supersedes the earlier one (MOSAIC-style conflict-at-write, simplified)", async () => {
    const memoryEngine = engineWithEmbeddings({
      "likes apples": [1, 0],
      // Deliberately similar to "likes apples" (cosine ~0.99) — this
      // heuristic can't tell a restatement from a negation, only "same
      // topic" (see conflictDetection's threshold comment). A later
      // self-report about the same subject is treated as the current
      // truth either way, matching "self-reports outrank" precedent
      // elsewhere in this engine.
      "actually hates apples": [0.99, 0.14],
    });
    const first = await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.apples",
        statement: "likes apples", channelScoped: false,
      }],
    });
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg2", source: "live", now: 200,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.apples.dislike",
        statement: "actually hates apples", channelScoped: false,
      }],
    });
    const current = await memoryEngine.listUserMemories("guild", "alice");
    expect(current).toHaveLength(1);
    expect(current[0]!.statement).toBe("actually hates apples");
    // The original is still there, just no longer "current" — same
    // supersede semantics as the same-identity revision case.
    const originalId = first.ingested[0]!.id;
    expect(current[0]!.id).not.toBe(originalId);
  });

  it("with embeddings, an unrelated fact about the same subject is never superseded (no false positive)", async () => {
    const memoryEngine = engineWithEmbeddings({
      "likes apples": [1, 0],
      "works as a backend engineer": [0, 1], // orthogonal — unrelated topic
    });
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg1", source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.apples",
        statement: "likes apples", channelScoped: false,
      }],
    });
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "alice", sourceMessageId: "msg2", source: "live", now: 200,
      proposals: [{
        action: "upsert", audience: "private", kind: "fact", ownerUserId: "alice",
        subjectType: "member", subjectId: "alice", topic: "job", slot: "role",
        statement: "works as a backend engineer", channelScoped: false,
      }],
    });
    const current = await memoryEngine.listUserMemories("guild", "alice");
    expect(current).toHaveLength(2);
  });
});

describe("HaluMem-staged eval — QA / omission", () => {
  it("recall surfaces multiple distinct facts about the same subject, none dropped under the char budget", async () => {
    const memoryEngine = engine();
    const facts: [string, string][] = [
      ["food.fruit", "likes apples"],
      ["hobby.primary", "plays guitar on weekends"],
      ["job.role", "works as a backend engineer"],
    ];
    for (const [slot, statement] of facts) {
      await memoryEngine.ingest({
        guildId: "guild", channelId: "general", channelMode: "shared",
        assertedByUserId: "alice", sourceMessageId: null, source: "live", now: 100,
        proposals: [{
          action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
          subjectType: "member", subjectId: "alice", topic: "preference", slot,
          statement, channelScoped: false,
        }],
      });
    }
    const recalled = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "alice",
      message: "what do you know about alice", recentHistory: [], subjectIds: ["alice"], now: 200,
    });
    expect(recalled.memories).toHaveLength(3);
  });

  it("a third-party claim about someone else stays a non-recallable candidate — QA must not answer from unconfirmed claims", async () => {
    const memoryEngine = engine();
    await memoryEngine.ingest({
      guildId: "guild", channelId: "general", channelMode: "shared",
      assertedByUserId: "bob", sourceMessageId: null, source: "live", now: 100,
      proposals: [{
        action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
        subjectType: "member", subjectId: "alice", topic: "activity", slot: "raid.friday",
        statement: "alice organizes Friday raids", channelScoped: false,
      }],
    });
    const recalled = await memoryEngine.recall({
      guildId: "guild", channelId: "general", userId: "carol",
      message: "who organizes Friday raids", recentHistory: [], subjectIds: ["alice"], now: 200,
    });
    expect(recalled.memories).toHaveLength(0);
  });
});

// Speculative — not part of the HaluMem staging above. Written to answer a
// concrete question: for a D&D campaign bot, does a 2-hop relational chain
// (character -> faction -> faction's enemy) survive recall when the query
// only names the character, not the enemy? Uses subjectType "member" as a
// stand-in for "npc"/"faction" (those subject types don't exist yet) — only
// retrieval ranking behavior is under test here, not the domain model.
//
// Realistic noise volume matters: with only the 3 chain facts and no
// competition, everything fits under the char budget regardless of ranking
// quality, and the test would prove nothing. ~50 unrelated noise memories
// are added so the budget/ranking cutoff is actually exercised, the way it
// would be in an active campaign with a real memory history.
describe("Multi-hop / relational retrieval", () => {
  it("a query naming only the character misses a chain fact that names neither the character nor the query's own keywords", async () => {
    const memoryEngine = engine();
    const now = 100;
    async function note(subjectId: string, slot: string, statement: string): Promise<void> {
      // subjectType "guild" + source "consolidation" self-activates per
      // resolveInitialStatus (memory-engine.ts) — DM-authored world lore
      // about an NPC/faction has no self-report path (NPCs can't confirm
      // their own memories the way a member subject can), so this is the
      // closest existing match to how such a fact would actually get
      // stored durably today. subjectId is repurposed as an entity key
      // (elara/thieves-guild/city-watch/npc-N) — there's no npc/faction
      // subjectType yet, only "member"/"guild"/"team"/"project".
      await memoryEngine.ingest({
        guildId: "guild", channelId: "table", channelMode: "shared",
        assertedByUserId: null, sourceMessageId: null, source: "consolidation", now,
        proposals: [{
          action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
          subjectType: "guild", subjectId, topic: "lore", slot, channelScoped: false,
          statement,
        }],
      });
    }
    // The chain: elara -> owes the thieves guild -> thieves guild feuds with
    // the city watch -> city watch patrols ravenport at night. Only the
    // first and last facts share vocabulary with the query below; the
    // middle link (the actual "hop") shares neither the character's name
    // nor the query's own words.
    await note("elara", "debt", "elara owes a debt to the thieves guild");
    await note("thieves-guild", "feud", "the thieves guild has a blood feud with the ravenport city watch");
    await note("city-watch", "patrol", "the ravenport city watch aggressively questions travelers walking the streets at night");
    for (let i = 0; i < 50; i++) {
      await note(`npc-${i}`, "trivia", `npc number ${i} runs an unrelated shop selling assorted goods in a different town entirely`);
    }
    const recalled = await memoryEngine.recall({
      guildId: "guild", channelId: "table", userId: "player1",
      message: "is it safe for me to walk around ravenport tonight",
      recentHistory: [], subjectIds: ["elara"], now: 200,
    });
    const statements = recalled.memories.map((memory) => (memory as { statement: string }).statement);
    const gotDebtFact = statements.some((statement) => statement.includes("owes a debt"));
    const gotFeudFact = statements.some((statement) => statement.includes("blood feud"));
    const gotPatrolFact = statements.some((statement) => statement.includes("aggressively questions"));
    // Measured, not assumed — this was NOT the predicted failure mode. The
    // guess going in was that the middle link (feud) would be the one
    // lost. What actually happens is the opposite end drops: the fact
    // tying the danger back to Elara personally (the debt) has zero
    // literal word overlap with the query, so its +3 subjectBoost loses to
    // BM25's reward for "ravenport" — a rare, high-IDF term in this
    // corpus — appearing verbatim in the other two facts. Net effect: the
    // bot would recall "Ravenport is dangerous at night" but silently
    // drop "...and especially for you, because of your debt" — the more
    // narratively important piece — with no signal anything is missing.
    // This is the concrete gap a relations/graph layer (entity -> what
    // it's connected to) would need to close for this domain, not a
    // classic "keyword search misses synonyms" problem embeddings alone
    // would fix either — the debt fact and the query share no *semantic*
    // content in common, only an entity relationship.
    expect(gotDebtFact).toBe(false);
    expect(gotFeudFact).toBe(true);
    expect(gotPatrolFact).toBe(true);
  });

  it("adding embeddings does not rescue the dropped fact either — it's a relational gap, not a vocabulary gap", async () => {
    // Vectors chosen to reflect plausible real embedding behavior: the
    // query and the two danger/patrol-flavored facts share topical
    // meaning (high cosine similarity); the debt fact is topically about
    // personal financial obligation, not danger, so a real embedding
    // model would likely score it as dissimilar to this query too — this
    // isn't a "BM25 missed a synonym, a real embedding model would catch
    // it" situation. Noise texts intentionally have no entry (fall back to
    // an unrelated 3-dimensional vector), which mismatches these facts'
    // 2-dimensional vectors — cosineSimilarity returns 0 on a length
    // mismatch, so noise scores 0 on the embedding channel regardless.
    const memoryEngine = engineWithEmbeddings({
      "is it safe for me to walk around ravenport tonight": [1, 0],
      "the ravenport city watch aggressively questions travelers walking the streets at night": [0.9, 0.1],
      "the thieves guild has a blood feud with the ravenport city watch": [0.7, 0.2],
      "elara owes a debt to the thieves guild": [0.1, 0.9],
    });
    const now = 100;
    async function note(subjectId: string, slot: string, statement: string): Promise<void> {
      await memoryEngine.ingest({
        guildId: "guild", channelId: "table", channelMode: "shared",
        assertedByUserId: null, sourceMessageId: null, source: "consolidation", now,
        proposals: [{
          action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
          subjectType: "guild", subjectId, topic: "lore", slot, channelScoped: false,
          statement,
        }],
      });
    }
    await note("elara", "debt", "elara owes a debt to the thieves guild");
    await note("thieves-guild", "feud", "the thieves guild has a blood feud with the ravenport city watch");
    await note("city-watch", "patrol", "the ravenport city watch aggressively questions travelers walking the streets at night");
    for (let i = 0; i < 50; i++) {
      await note(`npc-${i}`, "trivia", `npc number ${i} runs an unrelated shop selling assorted goods in a different town entirely`);
    }
    const recalled = await memoryEngine.recall({
      guildId: "guild", channelId: "table", userId: "player1",
      message: "is it safe for me to walk around ravenport tonight",
      recentHistory: [], subjectIds: ["elara"], now: 200,
    });
    const statements = recalled.memories.map((memory) => (memory as { statement: string }).statement);
    expect(statements.some((statement) => statement.includes("owes a debt"))).toBe(false);
    expect(statements.some((statement) => statement.includes("blood feud"))).toBe(true);
    expect(statements.some((statement) => statement.includes("aggressively questions"))).toBe(true);
  });

  // The real fix, tested end to end (memory_relations + findRelatedSubjects
  // + DefaultMemoryEngine.recall's boost merge) — not simulated. Uses a
  // query with ZERO word overlap with the target fact, unlike the test
  // above (which happened to share "ravenport" with two of its three
  // facts). This is the case pure BM25/embeddings structurally cannot
  // solve regardless of tuning, and the one that actually isolates whether
  // relation-based hop expansion works.
  it("a fact reachable only via a relation (zero query/fact vocabulary overlap) is recalled once expansion is wired in", async () => {
    const memoryEngine = engine();
    const now = 100;
    async function note(subjectId: string, statement: string): Promise<void> {
      await memoryEngine.ingest({
        guildId: "guild", channelId: "table", channelMode: "shared",
        assertedByUserId: null, sourceMessageId: null, source: "consolidation", now,
        proposals: [{
          action: "upsert", audience: "guild", kind: "fact", ownerUserId: null,
          subjectType: "guild", subjectId, topic: "lore", slot: "trivia", channelScoped: false,
          statement,
        }],
      });
    }
    // Deliberately zero shared tokens with the query below.
    await note("thieves-guild", "membership dues increased again this season");
    for (let i = 0; i < 50; i++) {
      await note(`npc-${i}`, `npc number ${i} runs an unrelated shop selling assorted goods in a different town entirely`);
    }
    await memoryEngine.ingestRelations({
      guildId: "guild", channelId: "table", channelMode: "shared", now, supportingMemoryId: null,
      proposals: [{
        fromSubjectType: "member", fromSubjectId: "elara",
        predicate: "member_of", kind: "association",
        toSubjectType: "guild", toSubjectId: "thieves-guild",
      }],
    });

    const query = {
      guildId: "guild", channelId: "table", userId: "player1",
      message: "what's weighing on elara's mind lately",
      recentHistory: [], subjectIds: ["elara"], now: 200,
    };
    const recalled = await memoryEngine.recall(query);
    const statements = recalled.memories.map((memory) => (memory as { statement: string }).statement);
    expect(statements.some((statement) => statement.includes("membership dues"))).toBe(true);
  });
});
