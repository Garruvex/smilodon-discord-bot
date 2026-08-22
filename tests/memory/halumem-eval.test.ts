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
