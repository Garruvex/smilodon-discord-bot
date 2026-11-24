import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GuardedConversationContext, type CitedSource } from "../../src/application/chat/guarded-conversation-context.js";
import type { ProposedRelation } from "../../src/application/memory/memory.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { ProvenanceAdmissionGate, parseProvenanceReaderModes, type ProvenanceDecision, type ProvenanceReaderMode } from "../../src/application/provenance/provenance-admission.js";
import { ProvenanceShadowWriter } from "../../src/application/provenance/provenance-shadow.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";
import { fixtureRelationIngest } from "../helpers/approved-memory-fixture.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

const owes = (from: string, to: string): ProposedRelation => ({ fromSubjectType: "member", fromSubjectId: from, predicate: "owes", kind: "consequence", toSubjectType: "member", toSubjectId: to });
interface Channel {
  fixture: ReturnType<typeof guardedFixture>; recorded: string[]; revoke: (messageId: string) => Promise<unknown>;
  related: (subjectId: string, hops?: number) => Promise<{ subjects: string[]; lease: GuardedConversationContext }>;
}

// Alice said "Alice owes Bob, and Bob owes Carol" in one message, and later "Carol owes Dave" in another.
// Each edge is its own graph artifact, identified by its payload.
async function channel(modes: string): Promise<Channel> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-relations-"))); close.push(() => connection.close());
  const graph = new SqliteProvenanceGraphStore(connection.database);
  const revocations = new SqliteMessageRevocationStore(connection.database);
  const gate = new ProvenanceAdmissionGate(graph, parseProvenanceReaderModes(modes));
  const repository = new SqliteMemoryRepository(connection.database); const engine = new DefaultMemoryEngine(repository);
  const writer = new ProvenanceShadowWriter(graph); const recorded: string[] = [];
  engine.observeArtifacts(async (artifact) => { recorded.push(`${artifact.kind}:${await writer.recordArtifact({ ...artifact, at: 4_500 })}`); });
  const fixture = guardedFixture(guardedEvent("edges", 4_000, "Alice owes Bob, and Bob owes Carol"));
  fixture.add(guardedEvent("other", 4_100, "Carol owes Dave"));
  for (const id of ["bob", "carol", "dave"]) fixture.actors.set(id, { id, displayName: id, roleNames: [], kind: "human" });
  fixture.port.sourcesAllowed = vi.fn((sources: readonly CitedSource[]) => Promise.resolve(sources.map(() => true)));
  fixture.port.revoked = (ids): Promise<readonly boolean[]> => revocations.revoked(ids.map((messageId) => ({ guildId: "guild", channelId: "channel", messageId })));
  fixture.port.graph = { mode: (kind): ProvenanceReaderMode => gate.mode(kind),
    decide: (kind, candidates, audienceUserId): Promise<ProvenanceDecision[]> => gate.decideDetailed(kind, { guildId: "guild", channelId: "channel", audienceUserId }, candidates) };
  const window = { count: 0, budget: 4_000, burstIds: [] };
  for (const [source, proposals] of [["edges", [owes("alice", "bob"), owes("bob", "carol")]], ["other", [owes("carol", "dave")]]] as const) {
    fixture.port.sourceMessageId = source;
    const context = await GuardedConversationContext.open(fixture.port, window);
    expect((await engine.ingestRelations(fixtureRelationIngest({ guildId: "guild", channelId: "channel", channelMode: "shared", proposals, context, supportingMemoryId: null, now: 4_500 }))).created)
      .toBe(proposals.length);
  }
  fixture.add(guardedEvent("query", 9_000, "who owes whom?")); fixture.port.sourceMessageId = "query";
  const revoke = (messageId: string): Promise<unknown> => revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: [messageId], revokedAt: 9_500 });
  const related = async (subjectId: string, hops = 1): Promise<{ subjects: string[]; lease: GuardedConversationContext }> => {
    const lease = await GuardedConversationContext.open(fixture.port, window);
    const found = await repository.findRelatedSubjects({ guildId: "guild", channelId: "channel", subjectIds: [subjectId], maxHops: hops, context: lease, now: 10_000 });
    return { subjects: found.map((subject) => subject.subjectId).sort(), lease };
  };
  return { fixture, recorded, revoke, related };
}

describe("relations read through the provenance graph", () => {
  it("admits each migrated edge as one graph input", async () => {
    const { recorded, related } = await channel("relation=v2");
    expect(recorded).toEqual(["relation:published", "relation:published", "relation:published"]);
    const { subjects, lease } = await related("alice", 2);
    expect(subjects).toEqual(["bob", "carol"]);
    const proof = lease.provenance("Alice owes Bob.")!;
    expect(proof.dependencies.map((dependency) => dependency.messageId)).not.toContain("edges");
    expect(proof.unresolved).toEqual(["graph_ancestry"]);
  });

  it("hides edges whose ancestor is revoked and keeps an unrelated one", async () => {
    const { revoke, related } = await channel("relation=v2");
    expect((await related("carol")).subjects).toEqual(["bob", "dave"]);
    await revoke("edges");
    expect((await related("carol")).subjects).toEqual(["dave"]);
    expect((await related("alice")).subjects).toEqual([]);
  });

  it("hides an edge with an ineligible participant and keeps an unrelated one", async () => {
    const { fixture, related } = await channel("relation=v2");
    fixture.actors.delete("bob");
    expect((await related("carol")).subjects).toEqual(["dave"]);
  });

  it("keeps the carried v1 path when relations read v1", async () => {
    const { related } = await channel("");
    const { subjects, lease } = await related("alice");
    expect(subjects).toEqual(["bob"]);
    expect(lease.provenance("Alice owes Bob.")!.dependencies.map((dependency) => dependency.messageId)).toContain("edges");
  });
});
