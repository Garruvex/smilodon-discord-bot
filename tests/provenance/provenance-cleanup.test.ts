import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashContent } from "../../src/application/assets/content-hash.js";
import { callbackProofPayload, callbackState } from "../../src/application/chat/character-callbacks.js";
import { DeletedMessageRevocations, type RevocationCleanupStep } from "../../src/application/chat/deleted-message-revocations.js";
import { GuardedConversationContext, type CitedSource } from "../../src/application/chat/guarded-conversation-context.js";
import { personaDriftPayload } from "../../src/application/chat/persona-drift-provenance.js";
import { PersonaDriftStore } from "../../src/application/chat/persona-drift-store.js";
import type { Memory, RelationCreateInput, RepositoryIngestInput } from "../../src/application/memory/memory.js";
import { memoryClaimPayload, memoryClaimProof } from "../../src/application/memory/memory-claim-provenance.js";
import { memoryRelationPayload } from "../../src/application/memory/memory-relation-provenance.js";
import { ProvenanceAdmissionGate, parseProvenanceReaderModes, type ProvenanceDecision, type ProvenanceReaderMode } from "../../src/application/provenance/provenance-admission.js";
import { graphArtifactCleanup } from "../../src/application/provenance/provenance-cleanup.js";
import { ProvenanceShadowWriter } from "../../src/application/provenance/provenance-shadow.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });
const logger = (): Logger => {
  const value = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  (value as unknown as { child: () => Logger }).child = (): Logger => value; return value;
};
const claimInput = (statement: string, slot: string, source: string): RepositoryIngestInput => ({ guildId: "guild", kind: "fact", audience: "channel", ownerUserId: null,
  channelId: "channel", isolationChannelId: null, subjectType: "member", subjectId: "alice", topic: "preference", slot, statement, status: "active", source: "live",
  importance: 1, embedding: null, embeddingModel: null, expiresAt: null, now: 1_000, sourceMessageId: source, sourceChannelId: "channel",
  assertedByUserId: "alice", sourceQuote: statement, sourceTimestampMs: 1_000 });

interface Seeded { repository: SqliteMemoryRepository; revocations: SqliteMessageRevocationStore; graph: SqliteProvenanceGraphStore; ids: Record<"claim" | "follow" | "unrelated", string>; relationCount: () => Promise<number> }

// "I like tea" became a claim. A later v2 turn used that claim through the graph and built a follow-up
// claim and a relation from it; their proofs cite neither the claim nor "I like tea". An unrelated claim
// was built from another message.
async function seed(): Promise<Seeded> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-cleanup-"))); close.push(() => connection.close());
  const graph = new SqliteProvenanceGraphStore(connection.database);
  const revocations = new SqliteMessageRevocationStore(connection.database);
  const repository = new SqliteMemoryRepository(connection.database);
  const gate = new ProvenanceAdmissionGate(graph, parseProvenanceReaderModes("claim=v2"));
  const writer = new ProvenanceShadowWriter(graph);
  const fixture = guardedFixture(guardedEvent("tea", 1_000, "I like tea"));
  fixture.add(guardedEvent("walks", 1_100, "I walk every morning"));
  fixture.port.sourcesAllowed = vi.fn((sources: readonly CitedSource[]) => Promise.resolve(sources.map(() => true)));
  fixture.port.revoked = (ids): Promise<readonly boolean[]> => revocations.revoked(ids.map((messageId) => ({ guildId: "guild", channelId: "channel", messageId })));
  fixture.port.graph = { mode: (kind): ProvenanceReaderMode => gate.mode(kind),
    decide: (kind, candidates, audienceUserId): Promise<ProvenanceDecision[]> => gate.decideDetailed(kind, { guildId: "guild", channelId: "channel", audienceUserId }, candidates) };
  const window = { count: 0, budget: 4_000, burstIds: [] };
  const stored = async (input: RepositoryIngestInput, lease: GuardedConversationContext): Promise<Memory> => {
    const memory = await repository.ingest({ ...input, contextProvenance: lease.provenance(memoryClaimPayload(input), "memory_claim") });
    expect(await writer.recordArtifact({ kind: "claim", artifactId: memory.id, proof: memoryClaimProof(memory.contextProvenance, memory, "graph")!, inputs: lease.graphInputs(), at: 2_000 }))
      .toBe("published");
    return memory;
  };
  fixture.port.sourceMessageId = "tea";
  const claim = await stored(claimInput("likes tea", "drink", "tea"), await GuardedConversationContext.open(fixture.port, window));
  fixture.port.sourceMessageId = "walks";
  const unrelated = await stored(claimInput("walks every morning", "habit", "walks"), await GuardedConversationContext.open(fixture.port, window));
  fixture.add(guardedEvent("lunch", 5_000, "what's good for lunch?")); fixture.port.sourceMessageId = "lunch";
  const turn = await GuardedConversationContext.open(fixture.port, window);
  expect(await turn.memories([claim], true)).toHaveLength(1);
  const follow = await stored(claimInput("orders tea at lunch", "lunch", "lunch"), turn);
  expect(follow.contextProvenance?.unresolved).toEqual(["graph_ancestry"]);
  const relation: RelationCreateInput = { guildId: "guild", channelId: "channel", fromSubjectType: "member", fromSubjectId: "alice", predicate: "owns", kind: "association",
    toSubjectType: "member", toSubjectId: "bob", isolationChannelId: null, supportingMemoryId: null, now: 5_000 };
  const payload = memoryRelationPayload(relation)!;
  const relationProof = turn.provenance(payload, "relation")!;
  expect(await repository.createRelations([{ ...relation, contextProvenance: relationProof }])).toBe(1);
  expect(await writer.recordArtifact({ kind: "relation", artifactId: hashContent(payload), proof: relationProof, inputs: turn.graphInputs(), at: 5_000 })).toBe("published");
  const relationCount = async (): Promise<number> => (await repository.findRelatedSubjects({ guildId: "guild", channelId: "channel", subjectIds: ["alice"], maxHops: 1 })).length;
  return { repository, revocations, graph, ids: { claim: claim.id, follow: follow.id, unrelated: unrelated.id }, relationCount };
}

function worker(seeded: Seeded, graph: boolean): DeletedMessageRevocations {
  const steps: RevocationCleanupStep[] = [
    { name: "memories", run: (guildId, channelId, messageIds): Promise<number> => seeded.repository.forgetCitingMessages({ guildId, channelId, messageIds }) },
    ...(graph ? [graphArtifactCleanup({ memories: seeded.repository, forgetDrift: () => Promise.resolve(0) })] : []),
  ];
  return new DeletedMessageRevocations({ store: seeded.revocations, honoured: () => true, steps, logger: logger(), settleMs: 0,
    ...(graph ? { descendants: (guildId: string, channelId: string, messageIds: readonly string[]) => seeded.graph.currentDescendants(guildId, channelId, messageIds) } : {}) });
}

describe("revocation cleanup follows the provenance graph", () => {
  it("removes stored artifacts whose only link to a revoked message is in the graph, and keeps unrelated ones", async () => {
    const seeded = await seed();
    expect(await seeded.relationCount()).toBe(1);
    await seeded.revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["tea"], revokedAt: 9_000 });
    expect(await worker(seeded, true).runOnce()).toBeGreaterThan(0);
    expect(await seeded.repository.findById("guild", seeded.ids.claim)).toBeNull();
    expect(await seeded.repository.findById("guild", seeded.ids.follow)).toBeNull();
    expect(await seeded.relationCount()).toBe(0);
    expect(await seeded.repository.findById("guild", seeded.ids.unrelated)).not.toBeNull();
  });

  it("would leave them behind with citation-based cleanup alone", async () => {
    const seeded = await seed();
    await seeded.revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["tea"], revokedAt: 9_000 });
    await worker(seeded, false).runOnce();
    expect(await seeded.repository.findById("guild", seeded.ids.claim)).toBeNull();
    expect(await seeded.repository.findById("guild", seeded.ids.follow)).not.toBeNull();
    expect(await seeded.relationCount()).toBe(1);
  });

  it("removes a drift only while it is still the descending version", async () => {
    const directory = mkdtempSync(join(tmpdir(), "provenance-drift-cleanup-"));
    const store = new PersonaDriftStore(directory);
    const epoch = randomUUID();
    const drift = { guildId: "guild", channelId: "chat", epoch, personalitySourceHash: hashContent("personality"), text: "grew fond of tea", updatedAt: 1 };
    const folder = join(directory, "guild-assets", "guild"); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "persona-drift.chat.json"), JSON.stringify({ ...drift, contextProvenance: { version: 1, purpose: "character_state", coverage: "partial",
      audience: { guildId: "guild", channelId: "chat", userId: null }, outputHash: hashContent(personaDriftPayload(drift)), unresolved: ["graph_ancestry"],
      dependencies: [{ guildId: "guild", channelId: "chat", messageId: "lunch", authorId: "alice", timestampMs: 1, representationHash: hashContent("lunch") }] } }));
    expect(await store.forgetVersions("guild", "chat", [{ artifactId: `persona-drift:${epoch}`, outputHash: hashContent("an earlier version") }])).toBe(0);
    expect(await store.forgetVersions("guild", "chat", [{ artifactId: "persona-drift:other-epoch", outputHash: hashContent(personaDriftPayload(drift)) }])).toBe(0);
    expect((await store.getScoped("guild", "chat"))?.text).toBe("grew fond of tea");
    expect(await store.forgetVersions("guild", "chat", [{ artifactId: `persona-drift:${epoch}`, outputHash: hashContent(personaDriftPayload(drift)) }])).toBe(1);
    expect(await store.getScoped("guild", "chat")).toBeNull();
  });
  it("clears a scheduled callback only while it is still the descending version, keeping the memory", async () => {
    const callback = { dueAt: 5_000, expiresAt: 9_000, status: "pending", revision: 1, attempts: 0, attemptId: null, leaseUntil: null, messageId: null,
      nextAttemptAt: 5_000, deliveryChannelId: "channel", sourceIds: ["exam"], eventMessageId: "exam" };
    const memory = { ...claimInput("exam on Friday", "exam", "exam"), id: "memory-1", updatedAt: 2_000, structuredValue: { callback, keep: true } } as unknown as Memory;
    const payload = callbackProofPayload(memory, callbackState(memory)!);
    const compareAndSetStructuredValue = vi.fn(() => Promise.resolve(true));
    const step = graphArtifactCleanup({ memories: { findById: () => Promise.resolve(memory), forget: vi.fn(() => Promise.resolve(0)), compareAndSetStructuredValue },
      forgetDrift: () => Promise.resolve(0) });
    expect(await step.run("guild", "channel", ["exam"], [{ kind: "callback", artifactId: "memory-1", outputHash: hashContent("a rescheduled version") }])).toBe(0);
    expect(compareAndSetStructuredValue).not.toHaveBeenCalled();
    expect(await step.run("guild", "channel", ["exam"], [{ kind: "callback", artifactId: "memory-1", outputHash: hashContent(payload) }])).toBe(1);
    expect(compareAndSetStructuredValue).toHaveBeenCalledWith({ guildId: "guild", memoryId: "memory-1", updatedAt: 2_000, expected: memory.structuredValue, value: { keep: true } });
  });
});
