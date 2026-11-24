import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CharacterMemory, type CharacterMemoryWrite } from "../../src/application/chat/character-memory.js";
import { GuardedConversationContext, type CitedSource } from "../../src/application/chat/guarded-conversation-context.js";
import type { Memory, RepositoryIngestInput } from "../../src/application/memory/memory.js";
import { memoryClaimPayload, memoryClaimProof } from "../../src/application/memory/memory-claim-provenance.js";
import { ProvenanceAdmissionGate, parseProvenanceReaderModes, type ProvenanceDecision, type ProvenanceReaderMode } from "../../src/application/provenance/provenance-admission.js";
import { ProvenanceShadowWriter } from "../../src/application/provenance/provenance-shadow.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { freshDocument, guildId, memoryProvider } from "../helpers/settings-fixtures.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

const window = { count: 3, budget: 12_000, burstIds: [] };
const claimInput = (statement: string): RepositoryIngestInput => ({ guildId, kind: "fact", audience: "channel", ownerUserId: null, channelId: "channel",
  isolationChannelId: null, subjectType: "member", subjectId: "alice", topic: "preference", slot: "drink", statement, status: "active", source: "live",
  importance: 1, embedding: null, embeddingModel: null, expiresAt: null, now: 1_000, sourceMessageId: "fact-src", sourceChannelId: "channel",
  assertedByUserId: "alice", sourceQuote: "I like tea", sourceTimestampMs: 1_000 });

// Alice said she likes tea; a claim was built from that message and recorded in the graph. Newer chatter
// has since pushed the message out of the recent window.
interface Channel {
  fixture: ReturnType<typeof guardedFixture>; graph: SqliteProvenanceGraphStore; gate: ProvenanceAdmissionGate; writer: ProvenanceShadowWriter; repository: SqliteMemoryRepository;
  claim: Memory; record: (memory: Memory, inputs?: ReturnType<GuardedConversationContext["graphInputs"]>) => Promise<string>;
  revoke: (messageId: string) => Promise<unknown>; open: () => Promise<GuardedConversationContext>;
}
async function channel(modes: string, input: { forgotten?: (source: CitedSource) => boolean; record?: boolean } = {}): Promise<Channel> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-claims-"))); close.push(() => connection.close());
  const graph = new SqliteProvenanceGraphStore(connection.database);
  const revocations = new SqliteMessageRevocationStore(connection.database);
  const repository = new SqliteMemoryRepository(connection.database);
  const gate = new ProvenanceAdmissionGate(graph, parseProvenanceReaderModes(modes));
  const writer = new ProvenanceShadowWriter(graph);
  const fixture = guardedFixture(guardedEvent("fact-src", 1_000, "I like tea"), { guildId, channelId: "channel" });
  fixture.port.sourcesAllowed = vi.fn((sources: readonly CitedSource[]) => Promise.resolve(sources.map((source) => !input.forgotten?.(source))));
  fixture.port.revoked = (ids): Promise<readonly boolean[]> => revocations.revoked(ids.map((messageId) => ({ guildId, channelId: "channel", messageId })));
  fixture.port.graph = { mode: (kind): ProvenanceReaderMode => gate.mode(kind),
    decide: (kind, candidates, audienceUserId): Promise<ProvenanceDecision[]> => gate.decideDetailed(kind, { guildId, channelId: "channel", audienceUserId }, candidates) };
  const source = await GuardedConversationContext.open(fixture.port, { count: 10, budget: 12_000, burstIds: [] });
  const claim = await repository.ingest({ ...claimInput("likes tea"), contextProvenance: source.provenance(memoryClaimPayload(claimInput("likes tea")), "memory_claim") });
  const record = async (memory: Memory, inputs = source.graphInputs()): Promise<string> =>
    writer.recordArtifact({ kind: "claim", artifactId: memory.id, proof: memoryClaimProof(memory.contextProvenance, memory, "graph")!, inputs, at: 2_000 });
  if (input.record !== false) expect(await record(claim)).toBe("published");
  for (let index = 0; index < 5; index++) fixture.add(guardedEvent(`recent-${index}`, 50_000 + index, `later ${index}`, "bob"));
  fixture.add(guardedEvent("current", 100_000, "what should I order?")); fixture.port.sourceMessageId = "current";
  const revoke = (messageId: string): Promise<unknown> => revocations.revoke({ guildId, channelId: "channel", messageIds: [messageId], revokedAt: 99_000 });
  return { fixture, graph, gate, writer, repository, claim, record, revoke, open: (): Promise<GuardedConversationContext> => GuardedConversationContext.open(fixture.port, window) };
}

const listed = (lease: GuardedConversationContext): string[] => lease.provenance("answer")!.dependencies.map((dependency) => dependency.messageId);

describe("claims read through the provenance graph", () => {
  it("retains a migrated claim as one graph input, and its edge carries a revocation to the reply built on it", async () => {
    const { fixture, gate, writer, claim, revoke, open } = await channel("claim=v2,reply_part=v2");
    const lease = await open();
    expect(await lease.memories([claim], true)).toEqual([expect.objectContaining({ id: claim.id })]);
    const proof = lease.provenance("Order a tea.")!;
    expect(listed(lease)).not.toContain("fact-src");
    expect(proof.coverage).toBe("partial");
    expect(proof.unresolved).toEqual(["graph_ancestry"]);
    expect(lease.graphInputs()).toContainEqual(expect.objectContaining({ artifact: { kind: "claim", artifactId: claim.id, outputHash: claim.contextProvenance!.outputHash } }));
    expect(lease.lineageMessageIds).toContain("fact-src");
    expect(await writer.recordReplyPart({ guildId, channelId: "channel", messageId: "bot-r", origin: "chat", contextProvenance: proof, createdAt: 3_000 } as never,
      lease.graphInputs())).toBe("published");
    const reply = { graphKind: "reply_part" as const, artifactId: "bot-r", v1: false };
    expect(await gate.decide("reply_part", { guildId, channelId: "channel", audienceUserId: null }, [reply])).toEqual([true]);
    await revoke("fact-src");
    // Both the old claim and the reply derived from it fail admission.
    expect(await (await open()).memories([claim], true)).toEqual([]);
    expect(await gate.decide("reply_part", { guildId, channelId: "channel", audienceUserId: null }, [reply])).toEqual([false]);
    fixture.sources.set("bot-r", { event: guardedEvent("bot-r", 3_000, "Order a tea.", "bot"), origin: "chat", provenance: proof });
    expect((await GuardedConversationContext.open(fixture.port, { count: 10, budget: 12_000, burstIds: [] })).history.map((event) => event.messageId)).not.toContain("bot-r");
  });

  it("admits only the version the graph holds as current after a correction", async () => {
    const { claim, record, open } = await channel("claim=v2");
    const correctedInput = claimInput("likes coffee");
    const writer = await open();
    const corrected: Memory = { ...claim, statement: "likes coffee", contextProvenance: writer.provenance(memoryClaimPayload(correctedInput), "memory_claim") };
    expect(await record(corrected, writer.graphInputs())).toBe("published");
    const lease = await open();
    expect((await lease.memories([claim, corrected], true)).map((memory) => memory.statement)).toEqual(["likes coffee"]);
  });

  it.each(["", "claim=shadow"])("keeps the carried v1 path with modes %j", async (modes) => {
    const { claim, open } = await channel(modes);
    const lease = await open();
    expect(await lease.memories([claim], true)).toHaveLength(1);
    expect(listed(lease)).toContain("fact-src");
    expect(lease.provenance("answer")!.coverage).toBe("complete");
  });

  it("keeps the v1 path for a claim the graph does not have", async () => {
    const { claim, open } = await channel("claim=v2", { record: false });
    const lease = await open();
    expect(await lease.memories([claim], true)).toHaveLength(1);
    expect(lease.provenance("answer")!.coverage).toBe("complete");
  });

  it("drops a migrated claim whose source author has been forgotten", async () => {
    const { claim, open } = await channel("claim=v2", { forgotten: (source) => source.messageId === "fact-src" });
    expect(await (await open()).memories([claim], true)).toEqual([]);
  });

  it("stops the next model call when the claim's source is revoked mid-turn", async () => {
    const { claim, revoke, open } = await channel("claim=v2");
    const lease = await open();
    expect(await lease.memories([claim], true)).toHaveLength(1);
    expect(await lease.validate("use")).toBe(true);
    await revoke("fact-src");
    expect(await lease.validate("use")).toBe(false);
  });

  it("stores a claim built on graph ancestry, hides it from v1 readers and admits it through the graph", async () => {
    const { claim, repository, record, open } = await channel("claim=v2");
    const turn = await open();
    expect(await turn.memories([claim], true)).toHaveLength(1);
    const followInput = { ...claimInput("orders tea at lunch"), slot: "lunch" };
    const follow = await repository.ingest({ ...followInput, contextProvenance: turn.provenance(memoryClaimPayload(followInput), "memory_claim") });
    expect(memoryClaimProof(follow.contextProvenance, follow)).toBeNull();
    expect(memoryClaimProof(follow.contextProvenance, follow, "graph")).not.toBeNull();
    expect(await record(follow, turn.graphInputs())).toBe("published");
    expect(await (await open()).memories([follow], true)).toHaveLength(1);
  });

  it("switches the character memory caller as well", async () => {
    const { fixture, graph, revoke, open } = await channel("claim=v2");
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-character-"))); close.push(() => connection.close());
    const memory = new CharacterMemory(new SqliteMemoryRepository(connection.database));
    const document = freshDocument(); document.features.chatbot = true; const profile = memoryProvider(document).current();
    const sourceContext = await GuardedConversationContext.open(fixture.port, { count: 10, budget: 12_000, burstIds: [] });
    const input: CharacterMemoryWrite = { kind: "state", audience: "channel", ownerUserId: null, channelId: "channel", isolationChannelId: null,
      subjectType: "persona", subjectId: "character", topic: "character.mood", slot: "fast-mood", statement: "amused", status: "active",
      source: "consolidation", importance: 1, embedding: null, embeddingModel: null, expiresAt: null, now: 5_000,
      sourceMessageId: "fact-src", sourceChannelId: "channel", assertedByUserId: null, structuredValue: { personaHash: "persona" }, sourceContext };
    const written = (await memory.write(profile, "channel", "mood", input))!;
    expect(written).not.toBeNull();
    expect(await new ProvenanceShadowWriter(graph).recordArtifact({ kind: "claim", artifactId: written.id, proof: memoryClaimProof(written.contextProvenance, written, "graph")!,
      inputs: sourceContext.graphInputs(), at: 6_000 })).toBe("published");
    const lease = await open();
    expect(await lease.characterMemories([written], true, 6_000)).toHaveLength(1);
    expect(lease.provenance("answer")!.unresolved).toEqual(["graph_ancestry"]);
    await revoke("fact-src");
    expect(await (await open()).characterMemories([written], true, 6_000)).toEqual([]);
  });
});
