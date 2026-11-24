import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GuardedConversationContext, type CitedSource } from "../../src/application/chat/guarded-conversation-context.js";
import type { Memory } from "../../src/application/memory/memory.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { observedSubjectNames } from "../../src/application/memory/observed-subject-names.js";
import { ProvenanceAdmissionGate, parseProvenanceReaderModes, type ProvenanceDecision, type ProvenanceReaderMode } from "../../src/application/provenance/provenance-admission.js";
import { ProvenanceShadowWriter } from "../../src/application/provenance/provenance-shadow.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";
import { fixtureMemoryIngest } from "../helpers/approved-memory-fixture.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

interface Channel { fixture: ReturnType<typeof guardedFixture>; row: Memory; recorded: string[]; revoke: (messageId: string) => Promise<unknown>; open: () => Promise<GuardedConversationContext> }

// Bob introduced himself as OldBob in one message and said he likes apples in the next. The claim cites
// both; its nested alias cites only the introduction. Each is its own graph artifact.
async function channel(modes: string): Promise<Channel> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-alias-"))); close.push(() => connection.close());
  const graph = new SqliteProvenanceGraphStore(connection.database);
  const revocations = new SqliteMessageRevocationStore(connection.database);
  const gate = new ProvenanceAdmissionGate(graph, parseProvenanceReaderModes(modes));
  const engine = new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database), null, null, undefined, null, null, null, () => true);
  const writer = new ProvenanceShadowWriter(graph); const recorded: string[] = [];
  engine.observeArtifacts(async (artifact) => { recorded.push(`${artifact.kind}:${await writer.recordArtifact({ ...artifact, at: 1_500 })}`); });
  const fixture = guardedFixture(guardedEvent("fact", 1_000, "I like apples.", "bob"));
  fixture.add(guardedEvent("intro", 900, "Call me OldBob.", "bob"));
  fixture.actors.set("bob", { id: "bob", displayName: "NewBob", roleNames: [], kind: "human" });
  fixture.port.sourcesAllowed = vi.fn((sources: readonly CitedSource[]) => Promise.resolve(sources.map(() => true)));
  fixture.port.revoked = (ids): Promise<readonly boolean[]> => revocations.revoked(ids.map((messageId) => ({ guildId: "guild", channelId: "channel", messageId })));
  fixture.port.graph = { mode: (kind): ProvenanceReaderMode => gate.mode(kind),
    decide: (kind, candidates, audienceUserId): Promise<ProvenanceDecision[]> => gate.decideDetailed(kind, { guildId: "guild", channelId: "channel", audienceUserId }, candidates) };
  const context = await GuardedConversationContext.open(fixture.port, { count: 10, budget: 4_000, burstIds: [] });
  const row = (await engine.ingest(fixtureMemoryIngest({ guildId: "guild", channelId: "channel", channelMode: "shared", assertedByUserId: "bob", sourceMessageId: "fact",
    source: "live", now: 1_000, context, proposals: [{ action: "upsert", audience: "guild", kind: "preference", ownerUserId: null, subjectType: "member", subjectId: "bob",
      topic: "preference", slot: "food.fruit", statement: "likes apples", channelScoped: true, observedSubjectNames: ["OldBob"] }] }))).ingested[0]!;
  fixture.add(guardedEvent("query", 2_000, "OldBob likes what?")); fixture.port.sourceMessageId = "query"; fixture.port.actorId = "alice";
  const revoke = (messageId: string): Promise<unknown> => revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: [messageId], revokedAt: 9_000 });
  return { fixture, row, recorded, revoke, open: () => GuardedConversationContext.open(fixture.port, { count: 0, budget: 4_000, burstIds: [] }) };
}

const aliasRows = async (lease: GuardedConversationContext, row: Memory): Promise<string[]> =>
  (await lease.aliases([row], "OldBob likes what?", 2_000)).rows.map((entry) => entry.alias);

describe("identity aliases read through the provenance graph", () => {
  it("records the claim and its alias separately, and admits the alias as one graph input", async () => {
    const { row, recorded, open } = await channel("alias=v2");
    expect(observedSubjectNames(row).map((name) => name.value)).toContain("OldBob");
    expect(recorded).toEqual(expect.arrayContaining(["claim:published", "alias:published"]));
    const lease = await open();
    expect(await aliasRows(lease, row)).toEqual(["OldBob"]);
    const proof = lease.provenance("OldBob is Bob.")!;
    expect(proof.dependencies.map((dependency) => dependency.messageId)).not.toContain("intro");
    expect(proof.unresolved).toEqual(["graph_ancestry"]);
  });

  it("keeps the alias when only the enclosing claim's other source is revoked", async () => {
    const { row, revoke, open } = await channel("alias=v2,claim=v2");
    await revoke("fact");
    const lease = await open();
    expect(await lease.memories([row], true)).toEqual([]);
    expect(await aliasRows(lease, row)).toEqual(["OldBob"]);
  });

  it("needs fresh independent profile evidence once the alias's own source is revoked", async () => {
    const { fixture, row, revoke, open } = await channel("alias=v2");
    await revoke("intro");
    expect(await aliasRows(await open(), row)).toEqual([]);
    fixture.actors.get("bob")!.displayName = "OldBob";
    const lease = await open();
    expect(await aliasRows(lease, row)).toEqual(["OldBob"]);
    // The fresh profile proof is complete on its own; nothing came through the graph.
    expect(lease.provenance("OldBob is Bob.")!.coverage).toBe("complete");
  });

  it("keeps the carried v1 path when aliases read v1", async () => {
    const { row, open } = await channel("");
    const lease = await open();
    expect(await aliasRows(lease, row)).toEqual(["OldBob"]);
    expect(lease.provenance("OldBob is Bob.")!.dependencies.map((dependency) => dependency.messageId)).toContain("intro");
  });
});
