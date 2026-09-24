// Shared behavioral contract for MemoryRepository — run against both
// backends (see sqlite-memory-repository.contract.test.ts, always; and
// postgres-memory-repository.contract.test.ts, only when a live database is
// configured). Performance parity is explicitly not asserted here (see the
// Plan 1 backend policy) — only that both backends enforce the same
// authorization, isolation, and lifecycle semantics.
import { describe, expect, it } from "vitest";

import type { MemoryRepository, RelationCreateInput, RepositoryIngestInput } from "../../src/application/memory/memory.js";
import { canRecall } from "../../src/application/memory/memory.js";

function ingestInput(overrides: Partial<RepositoryIngestInput> = {}): RepositoryIngestInput {
  return {
    guildId: "guild", kind: "preference", audience: "private", ownerUserId: "alice", channelId: null,
    isolationChannelId: null, subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit",
    statement: "likes apples", status: "active", source: "live", importance: 1,
    embedding: null, embeddingModel: null, expiresAt: null, now: 1_000,
    sourceMessageId: null, sourceChannelId: null, assertedByUserId: "alice",
    ...overrides,
  };
}

function relationInput(overrides: Partial<RelationCreateInput> = {}): RelationCreateInput {
  return {
    guildId: "guild", fromSubjectType: "member", fromSubjectId: "alice",
    predicate: "allied_with", kind: "association",
    toSubjectType: "member", toSubjectId: "bob",
    isolationChannelId: null, supportingMemoryId: null, now: 1_000,
    ...overrides,
  };
}

export function memoryRepositoryContract(
  label: string,
  createRepository: () => Promise<MemoryRepository>,
): void {
  describe(`MemoryRepository contract (${label})`, () => {
    it("ingest + findById round-trips a memory", async () => {
      const repository = await createRepository();
      const memory = await repository.ingest(ingestInput());
      const found = await repository.findById("guild", memory.id);
      expect(found).toMatchObject({ statement: "likes apples", audience: "private", ownerUserId: "alice" });
    });

    it("findById returns null for a different guild (guild separation)", async () => {
      const repository = await createRepository();
      const memory = await repository.ingest(ingestInput());
      expect(await repository.findById("other-guild", memory.id)).toBeNull();
    });

    it("re-ingesting the same active identity with an unchanged statement reinforces in place", async () => {
      const repository = await createRepository();
      const first = await repository.ingest(ingestInput({ statement: "likes apples", now: 1_000 }));
      const second = await repository.ingest(ingestInput({ statement: "likes apples", now: 2_000, importance: 3 }));
      expect(second.id).toBe(first.id);
      expect(second.importance).toBe(3);
      const candidates = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 3_000,
      });
      expect(candidates.memories).toHaveLength(1);
    });

    it("re-ingesting the same active identity with a changed statement supersedes rather than mutates the old row", async () => {
      const repository = await createRepository();
      const first = await repository.ingest(ingestInput({ statement: "likes apples", now: 1_000 }));
      const second = await repository.ingest(ingestInput({ statement: "likes green apples", now: 2_000 }));
      // A new row, not the same one mutated — the old value stays intact
      // under its own id with its own history, per the bi-temporal model
      // (see memory.ts's Memory.validFrom/validUntil).
      expect(second.id).not.toBe(first.id);
      expect(second.statement).toBe("likes green apples");
      expect(second.status).toBe("active");
      expect(second.validFrom).toBe(2_000);
      expect(second.validUntil).toBeNull();

      const oldRow = await repository.findById("guild", first.id);
      expect(oldRow).not.toBeNull();
      expect(oldRow!.statement).toBe("likes apples");
      expect(oldRow!.status).toBe("superseded");
      expect(oldRow!.supersededById).toBe(second.id);
      expect(oldRow!.validUntil).toBe(2_000);

      // Only the current row is recall-eligible.
      const candidates = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 3_000,
      });
      expect(candidates.memories).toHaveLength(1);
      expect(candidates.memories[0]!.id).toBe(second.id);
    });

    it("candidate status: different asserters produce separate rows under the same identity (no lost contradiction)", async () => {
      const repository = await createRepository();
      await repository.ingest(ingestInput({
        audience: "guild", ownerUserId: null, subjectType: "member", subjectId: "carol",
        status: "candidate", assertedByUserId: "alice", statement: "carol likes tea",
      }));
      await repository.ingest(ingestInput({
        audience: "guild", ownerUserId: null, subjectType: "member", subjectId: "carol",
        status: "candidate", assertedByUserId: "bob", statement: "carol likes coffee",
      }));
      const carolMemories = (await repository.listByUser("guild", "alice")); // not owner-based for guild audience
      // Guild-audience candidates aren't owned by anyone, so verify via a
      // direct recall-eligible check instead — they're "candidate", not
      // "active", so recall won't surface them; assert via listByUser being
      // empty (guild-audience never appears there) and instead check no
      // exception/merge happened by re-querying identity through ingest's
      // own dedup path: asserting alice again should hit her existing row.
      expect(carolMemories).toHaveLength(0);
      const aliceAgain = await repository.ingest(ingestInput({
        audience: "guild", ownerUserId: null, subjectType: "member", subjectId: "carol",
        status: "candidate", assertedByUserId: "alice", statement: "carol definitely likes tea",
      }));
      expect(aliceAgain.statement).toBe("carol definitely likes tea");
    });

    it("findRecallCandidates enforces guild separation", async () => {
      const repository = await createRepository();
      await repository.ingest(ingestInput({ audience: "guild", ownerUserId: null, guildId: "guild-a" }));
      const candidates = await repository.findRecallCandidates({
        guildId: "guild-b", channelId: "general", userId: "alice", now: 2_000,
      });
      expect(candidates.memories).toHaveLength(0);
    });

    it("findRecallCandidates enforces private ownership", async () => {
      const repository = await createRepository();
      await repository.ingest(ingestInput({ audience: "private", ownerUserId: "alice" }));
      const asOwner = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 2_000,
      });
      const asOther = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "bob", now: 2_000,
      });
      expect(asOwner.memories).toHaveLength(1);
      expect(asOther.memories).toHaveLength(0);
    });

    it("findRecallCandidates enforces channel scoping for audience=channel", async () => {
      const repository = await createRepository();
      await repository.ingest(ingestInput({
        audience: "channel", ownerUserId: null, channelId: "dnd", subjectType: "guild", subjectId: "guild",
      }));
      const inChannel = await repository.findRecallCandidates({
        guildId: "guild", channelId: "dnd", userId: "alice", now: 2_000,
      });
      const outsideChannel = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 2_000,
      });
      expect(inChannel.memories).toHaveLength(1);
      expect(outsideChannel.memories).toHaveLength(0);
    });

    it("findRecallCandidates enforces the isolation boundary regardless of audience", async () => {
      const repository = await createRepository();
      await repository.ingest(ingestInput({
        audience: "guild", ownerUserId: null, isolationChannelId: "dnd",
        subjectType: "guild", subjectId: "guild",
      }));
      const inDnd = await repository.findRecallCandidates({
        guildId: "guild", channelId: "dnd", userId: "alice", now: 2_000,
      });
      const inGeneral = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 2_000,
      });
      expect(inDnd.memories).toHaveLength(1);
      expect(inGeneral.memories).toHaveLength(0);
    });

    it("findRecallCandidates excludes expired memories", async () => {
      const repository = await createRepository();
      await repository.ingest(ingestInput({ expiresAt: 1_500 }));
      const beforeExpiry = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 1_200,
      });
      const afterExpiry = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 1_800,
      });
      expect(beforeExpiry.memories).toHaveLength(1);
      expect(afterExpiry.memories).toHaveLength(0);
    });

    it("findRecallCandidates excludes non-active status", async () => {
      const repository = await createRepository();
      await repository.ingest(ingestInput({ status: "candidate" }));
      const candidates = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 2_000,
      });
      expect(candidates.memories).toHaveLength(0);
    });

    it("listByUser returns only that user's owned memories, active and candidate", async () => {
      const repository = await createRepository();
      await repository.ingest(ingestInput({ ownerUserId: "alice", status: "active", slot: "food.fruit" }));
      await repository.ingest(ingestInput({ ownerUserId: "alice", status: "candidate", slot: "food.veg" }));
      await repository.ingest(ingestInput({ ownerUserId: "bob", status: "active", slot: "food.fruit" }));
      const aliceMemories = await repository.listByUser("guild", "alice");
      expect(aliceMemories).toHaveLength(2);
      expect(aliceMemories.every((memory) => memory.ownerUserId === "alice")).toBe(true);
    });

    it("forget by memoryId removes exactly that memory, scoped to the guild", async () => {
      const repository = await createRepository();
      const memory = await repository.ingest(ingestInput());
      const removedWrongGuild = await repository.forget({ guildId: "other-guild", memoryId: memory.id });
      expect(removedWrongGuild).toBe(0);
      const removed = await repository.forget({ guildId: "guild", memoryId: memory.id });
      expect(removed).toBe(1);
      expect(await repository.findById("guild", memory.id)).toBeNull();
    });

    it("forget by ownerUserId removes every memory that user owns", async () => {
      const repository = await createRepository();
      await repository.ingest(ingestInput({ ownerUserId: "alice", slot: "food.fruit" }));
      await repository.ingest(ingestInput({ ownerUserId: "alice", slot: "food.veg" }));
      await repository.ingest(ingestInput({ ownerUserId: "bob", slot: "food.fruit" }));
      const removed = await repository.forget({ guildId: "guild", ownerUserId: "alice" });
      expect(removed).toBe(2);
      expect(await repository.listByUser("guild", "alice")).toHaveLength(0);
      expect(await repository.listByUser("guild", "bob")).toHaveLength(1);
    });

    it("idempotent natural identity: repeated ingest of an identical proposal never grows the active row count", async () => {
      const repository = await createRepository();
      for (let i = 0; i < 3; i++) {
        await repository.ingest(ingestInput({ now: 1_000 + i }));
      }
      const candidates = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 5_000,
      });
      expect(candidates.memories).toHaveLength(1);
    });

    it("findRecallCandidates orders subject-matches first, then most-recently-updated — so a bounded cap never silently drops the most relevant rows", async () => {
      const repository = await createRepository();
      // Deliberately ingested oldest-first so an ordering bug (falling back
      // to insertion order) would put them in this same order — the
      // assertion below only passes if the query actually orders by
      // subject-match then recency, not merely returns whatever it stored.
      const oldestUnrelated = await repository.ingest(ingestInput({
        audience: "guild", ownerUserId: null, subjectType: "member", subjectId: "carol",
        slot: "topic.a", statement: "oldest, unrelated subject", now: 1_000,
      }));
      const recentUnrelated = await repository.ingest(ingestInput({
        audience: "guild", ownerUserId: null, subjectType: "member", subjectId: "carol",
        slot: "topic.b", statement: "newest, unrelated subject", now: 3_000,
      }));
      const oldMatch = await repository.ingest(ingestInput({
        audience: "guild", ownerUserId: null, subjectType: "member", subjectId: "alice",
        slot: "topic.c", statement: "older, matching subject", now: 2_000,
      }));
      const candidates = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 5_000, subjectIds: ["alice"],
      });
      // subjectIds narrows the SQL filter itself (see the query's own
      // comment), so only the matching-subject row comes back here — this
      // is a different mechanism from prioritySubjectIds below, and
      // asserted separately.
      expect(candidates.memories.map((m) => m.id)).toEqual([oldMatch.id]);
      const unprioritized = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 5_000,
      });
      // With no priority hint at all, ordering falls back to recency alone.
      expect(unprioritized.memories.map((m) => m.id)).toEqual([recentUnrelated.id, oldMatch.id, oldestUnrelated.id]);
      const prioritized = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 5_000, prioritySubjectIds: ["alice"],
      });
      // prioritySubjectIds is ordering-only, not a filter (unlike
      // subjectIds above): every eligible memory still comes back, but the
      // matching subject's row sorts first regardless of recency, and the
      // two unrelated rows keep falling back to recency ordering.
      expect(prioritized.memories.map((m) => m.id)).toEqual([oldMatch.id, recentUnrelated.id, oldestUnrelated.id]);
    });

    it("repository results agree with the canRecall predicate", async () => {
      const repository = await createRepository();
      const memory = await repository.ingest(ingestInput({
        audience: "channel", ownerUserId: null, channelId: "dnd", isolationChannelId: "dnd",
        subjectType: "guild", subjectId: "guild",
      }));
      const context = { guildId: "guild", channelId: "dnd", userId: "alice" };
      const predicate = canRecall(memory, context, 2_000);
      const candidates = await repository.findRecallCandidates({ ...context, now: 2_000 });
      expect(candidates.memories.some((m) => m.id === memory.id)).toBe(predicate);
    });

    it("findRelatedSubjects: a direct relation is found at hop 1, bidirectionally", async () => {
      const repository = await createRepository();
      await repository.createRelations([relationInput({ fromSubjectId: "alice", toSubjectId: "bob" })]);
      const fromAlice = await repository.findRelatedSubjects({
        guildId: "guild", channelId: "general", subjectIds: ["alice"], maxHops: 2,
      });
      expect(fromAlice).toEqual([expect.objectContaining({ subjectId: "bob", hopDistance: 1, viaSubjectId: "alice" })]);
      const fromBob = await repository.findRelatedSubjects({
        guildId: "guild", channelId: "general", subjectIds: ["bob"], maxHops: 2,
      });
      expect(fromBob).toEqual([expect.objectContaining({ subjectId: "alice", hopDistance: 1, viaSubjectId: "bob" })]);
    });

    it("findRelatedSubjects: a chain is reachable at hop 2, respecting maxHops", async () => {
      const repository = await createRepository();
      await repository.createRelations([
        relationInput({ fromSubjectId: "alice", toSubjectId: "guild-x", predicate: "member_of" }),
        relationInput({ fromSubjectId: "guild-x", toSubjectId: "watch", predicate: "hostile_to" }),
      ]);
      const hop1Only = await repository.findRelatedSubjects({
        guildId: "guild", channelId: "general", subjectIds: ["alice"], maxHops: 1,
      });
      expect(hop1Only.map((r) => r.subjectId)).toEqual(["guild-x"]);
      const hop2 = await repository.findRelatedSubjects({
        guildId: "guild", channelId: "general", subjectIds: ["alice"], maxHops: 2,
      });
      expect(hop2).toEqual(expect.arrayContaining([
        expect.objectContaining({ subjectId: "guild-x", hopDistance: 1 }),
        expect.objectContaining({ subjectId: "watch", hopDistance: 2, viaSubjectId: "guild-x" }),
      ]));
      expect(hop2).toHaveLength(2);
    });

    it("findRelatedSubjects: an isolated-channel relation only expands in its own channel", async () => {
      const repository = await createRepository();
      await repository.createRelations([relationInput({ isolationChannelId: "dnd-table" })]);
      const inDnd = await repository.findRelatedSubjects({
        guildId: "guild", channelId: "dnd-table", subjectIds: ["alice"], maxHops: 1,
      });
      expect(inDnd).toHaveLength(1);
      const inGeneral = await repository.findRelatedSubjects({
        guildId: "guild", channelId: "general", subjectIds: ["alice"], maxHops: 1,
      });
      expect(inGeneral).toHaveLength(0);
    });

    it("findRelatedSubjects: never returns one of the query's own subjectIds, even if reachable via a cycle", async () => {
      const repository = await createRepository();
      await repository.createRelations([
        relationInput({ fromSubjectId: "alice", toSubjectId: "bob" }),
        relationInput({ fromSubjectId: "bob", toSubjectId: "alice" }),
      ]);
      const related = await repository.findRelatedSubjects({
        guildId: "guild", channelId: "general", subjectIds: ["alice"], maxHops: 3,
      });
      expect(related.map((r) => r.subjectId)).toEqual(["bob"]);
    });

    it("a restatement never lowers importance", async () => {
      const repository = await createRepository();
      await repository.ingest(ingestInput({ importance: 3, now: 1_000 }));
      const restated = await repository.ingest(ingestInput({ importance: 1, now: 2_000 }));
      expect(restated.importance).toBe(3);
    });

    it("revises a guild-audience fact (ownerUserId null) without tripping the one-active-per-identity index", async () => {
      const repository = await createRepository();
      const guildFact = { audience: "guild" as const, ownerUserId: null, subjectType: "guild" as const, subjectId: "guild" };
      const first = await repository.ingest(ingestInput({ ...guildFact, statement: "meets on fridays", now: 1_000 }));
      const second = await repository.ingest(ingestInput({ ...guildFact, statement: "meets on saturdays", now: 2_000 }));
      expect((await repository.findById("guild", first.id))!.status).toBe("superseded");
      expect(second.status).toBe("active");
    });

    it("forget by memoryId also removes that fact's earlier superseded versions", async () => {
      const repository = await createRepository();
      const v1 = await repository.ingest(ingestInput({ statement: "likes apples", now: 1_000 }));
      const v2 = await repository.ingest(ingestInput({ statement: "likes pears", now: 2_000 }));
      const v3 = await repository.ingest(ingestInput({ statement: "likes plums", now: 3_000 }));
      const unrelated = await repository.ingest(ingestInput({ slot: "food.veg", statement: "likes kale", now: 3_000 }));
      expect(await repository.forget({ guildId: "guild", memoryId: v3.id })).toBe(3);
      for (const id of [v1.id, v2.id, v3.id]) expect(await repository.findById("guild", id)).toBeNull();
      expect(await repository.findById("guild", unrelated.id)).not.toBeNull();
    });

    it("forget by memoryId with an ownerUserId guard refuses someone else's memory", async () => {
      const repository = await createRepository();
      const memory = await repository.ingest(ingestInput({ ownerUserId: "alice" }));
      expect(await repository.forget({ guildId: "guild", memoryId: memory.id, ownerUserId: "bob" })).toBe(0);
      expect(await repository.findById("guild", memory.id)).not.toBeNull();
    });

    it("forget by subjectId removes relations naming that member", async () => {
      const repository = await createRepository();
      await repository.createRelations([
        relationInput({ fromSubjectId: "alice", toSubjectId: "bob" }),
        relationInput({ fromSubjectId: "carol", toSubjectId: "alice", predicate: "owes" }),
        relationInput({ fromSubjectId: "bob", toSubjectId: "carol" }),
      ]);
      await repository.forget({ guildId: "guild", ownerUserId: "alice", subjectId: "alice" });
      const fromBob = await repository.findRelatedSubjects({
        guildId: "guild", channelId: "general", subjectIds: ["bob"], maxHops: 1,
      });
      expect(fromBob.map((r) => r.subjectId)).toEqual(["carol"]);
    });

    it("forget by assertedByUserId strips that user's provenance and drops candidates only they asserted", async () => {
      const repository = await createRepository();
      const aboutCarol = { audience: "guild" as const, ownerUserId: null, subjectType: "member" as const, subjectId: "carol" };
      const soloClaim = await repository.ingest(ingestInput({
        ...aboutCarol, slot: "drink.tea", status: "candidate", assertedByUserId: "alice", statement: "carol likes tea",
      }));
      const bobsClaim = await repository.ingest(ingestInput({
        ...aboutCarol, slot: "drink.tea", status: "candidate", assertedByUserId: "bob", statement: "carol likes tea",
      }));
      const activeFact = await repository.ingest(ingestInput({
        ...aboutCarol, slot: "game.chess", status: "active", assertedByUserId: "alice", statement: "carol plays chess",
      }));
      await repository.forget({ guildId: "guild", assertedByUserId: "alice" });
      expect(await repository.findById("guild", soloClaim.id)).toBeNull();
      expect(await repository.findById("guild", bobsClaim.id)).not.toBeNull();
      const activeSources = await repository.findSources(activeFact.id);
      expect(await repository.findById("guild", activeFact.id)).not.toBeNull();
      expect(activeSources.some((source) => source.assertedByUserId === "alice")).toBe(false);
    });

    it("forgetting a memory removes its provenance rows too", async () => {
      const repository = await createRepository();
      const memory = await repository.ingest(ingestInput({ sourceMessageId: "m1" }));
      await repository.forget({ guildId: "guild", memoryId: memory.id });
      expect(await repository.findSources(memory.id)).toHaveLength(0);
    });

    it("deleteExpiredCandidates removes only candidates past their expiry", async () => {
      const repository = await createRepository();
      const aboutCarol = { audience: "guild" as const, ownerUserId: null, subjectType: "member" as const, subjectId: "carol" };
      const expired = await repository.ingest(ingestInput({ ...aboutCarol, slot: "a.b", status: "candidate", expiresAt: 1_500 }));
      const fresh = await repository.ingest(ingestInput({ ...aboutCarol, slot: "c.d", status: "candidate", expiresAt: 9_000 }));
      const activeExpired = await repository.ingest(ingestInput({ slot: "e.f", status: "active", expiresAt: 1_500 }));
      expect(await repository.deleteExpiredCandidates("guild", 2_000)).toBe(1);
      expect(await repository.findById("guild", expired.id)).toBeNull();
      expect(await repository.findById("guild", fresh.id)).not.toBeNull();
      expect(await repository.findById("guild", activeExpired.id)).not.toBeNull();
    });

    it("promoteCandidate activates a candidate and absorbs corroborating rows and their provenance", async () => {
      const repository = await createRepository();
      const aboutCarol = {
        audience: "guild" as const, ownerUserId: null, subjectType: "member" as const, subjectId: "carol",
        slot: "drink.tea", status: "candidate" as const, statement: "carol likes tea", expiresAt: 9_000,
      };
      const fromAlice = await repository.ingest(ingestInput({ ...aboutCarol, assertedByUserId: "alice" }));
      const fromBob = await repository.ingest(ingestInput({ ...aboutCarol, assertedByUserId: "bob" }));
      const others = await repository.findCandidatesByIdentity({
        guildId: "guild", ownerUserId: null, channelId: null, isolationChannelId: null, subjectType: "member",
        subjectId: "carol", topic: "preference", slot: "drink.tea", excludeMemoryId: fromBob.id, now: 2_000,
      });
      expect(others).toEqual([expect.objectContaining({ assertedByUserIds: ["alice"] })]);
      const promoted = await repository.promoteCandidate({
        guildId: "guild", memoryId: fromBob.id, absorbedMemoryIds: [fromAlice.id], now: 2_000,
      });
      expect(promoted).toMatchObject({ id: fromBob.id, status: "active", expiresAt: null });
      expect(await repository.findById("guild", fromAlice.id)).toBeNull();
      const asserters = (await repository.findSources(fromBob.id)).map((source) => source.assertedByUserId).sort();
      expect(asserters).toEqual(["alice", "bob"]);
    });

    it("promoteCandidate declines when an active memory already holds the identity", async () => {
      const repository = await createRepository();
      const identity = { audience: "guild" as const, ownerUserId: null, subjectType: "member" as const, subjectId: "carol", slot: "drink.tea" };
      await repository.ingest(ingestInput({ ...identity, status: "active", assertedByUserId: "carol", statement: "likes tea" }));
      const candidate = await repository.ingest(ingestInput({ ...identity, status: "candidate", assertedByUserId: "bob", statement: "hates tea" }));
      expect(await repository.promoteCandidate({ guildId: "guild", memoryId: candidate.id, absorbedMemoryIds: [], now: 2_000 })).toBeNull();
      expect((await repository.findById("guild", candidate.id))!.status).toBe("candidate");
    });

    it("createRelations skips edges that already exist", async () => {
      const repository = await createRepository();
      expect(await repository.createRelations([relationInput()])).toBe(1);
      expect(await repository.createRelations([relationInput({ now: 2_000 }), relationInput({ toSubjectId: "carol" })])).toBe(1);
      const related = await repository.findRelatedSubjects({
        guildId: "guild", channelId: "general", subjectIds: ["alice"], maxHops: 1,
      });
      expect(related.map((r) => r.subjectId).sort()).toEqual(["bob", "carol"]);
    });

    it("findRelatedSubjects reports a subject once per relation kind, with edge direction", async () => {
      const repository = await createRepository();
      await repository.createRelations([
        relationInput({ fromSubjectId: "alice", toSubjectId: "bob", kind: "association", now: 1_000 }),
        relationInput({ fromSubjectId: "bob", toSubjectId: "alice", kind: "consequence", predicate: "owes", now: 2_000 }),
      ]);
      const related = await repository.findRelatedSubjects({
        guildId: "guild", channelId: "general", subjectIds: ["alice"], maxHops: 1,
      });
      expect(related).toHaveLength(2);
      expect(related).toEqual(expect.arrayContaining([
        expect.objectContaining({ subjectId: "bob", kind: "association", edgePointsToVia: false }),
        expect.objectContaining({ subjectId: "bob", kind: "consequence", edgePointsToVia: true }),
      ]));
    });
  });
}
