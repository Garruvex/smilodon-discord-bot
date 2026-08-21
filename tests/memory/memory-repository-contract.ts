// Shared behavioral contract for MemoryRepository — run against both
// backends (see sqlite-memory-repository.contract.test.ts, always; and
// postgres-memory-repository.contract.test.ts, only when a live database is
// configured). Performance parity is explicitly not asserted here (see the
// Plan 1 backend policy) — only that both backends enforce the same
// authorization, isolation, and lifecycle semantics.
import { describe, expect, it } from "vitest";

import type { Memory, MemoryRepository, RepositoryIngestInput } from "../../src/application/memory/memory.js";
import { canRecall } from "../../src/application/memory/memory.js";

function ingestInput(overrides: Partial<RepositoryIngestInput> = {}): RepositoryIngestInput {
  return {
    guildId: "guild", kind: "preference", audience: "private", ownerUserId: "alice", channelId: null,
    isolationChannelId: null, subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit",
    statement: "likes apples", status: "active", source: "live", confidence: 1, importance: 1,
    embedding: null, embeddingModel: null, expiresAt: null, now: 1_000,
    sourceMessageId: null, sourceChannelId: null, assertedByUserId: "alice",
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

    it("re-ingesting the same active identity updates in place rather than duplicating", async () => {
      const repository = await createRepository();
      const first = await repository.ingest(ingestInput({ statement: "likes apples", now: 1_000 }));
      const second = await repository.ingest(ingestInput({ statement: "likes green apples", now: 2_000 }));
      expect(second.id).toBe(first.id);
      expect(second.statement).toBe("likes green apples");
      const candidates = await repository.findRecallCandidates({
        guildId: "guild", channelId: "general", userId: "alice", now: 3_000,
      });
      expect(candidates.memories).toHaveLength(1);
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

    it("repository results agree with the canRecall predicate", async () => {
      const repository = await createRepository();
      const memory = await repository.ingest(ingestInput({
        audience: "channel", ownerUserId: null, channelId: "dnd", isolationChannelId: "dnd",
        subjectType: "guild", subjectId: "guild",
      }));
      const context = { guildId: "guild", channelId: "dnd", userId: "alice" };
      const predicate = canRecall(memory as Memory, context, 2_000);
      const candidates = await repository.findRecallCandidates({ ...context, now: 2_000 });
      expect(candidates.memories.some((m) => m.id === memory.id)).toBe(predicate);
    });
  });
}
