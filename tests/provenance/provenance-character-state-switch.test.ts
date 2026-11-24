import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContextProvenance } from "../../src/application/chat/context-provenance.js";
import { GuardedConversationContext, type CitedSource, type GraphArtifactRef } from "../../src/application/chat/guarded-conversation-context.js";
import { ProvenanceAdmissionGate, parseProvenanceReaderModes, type ProvenanceDecision, type ProvenanceReaderMode } from "../../src/application/provenance/provenance-admission.js";
import { ProvenanceShadowWriter } from "../../src/application/provenance/provenance-shadow.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

const drift: GraphArtifactRef = { kind: "character_state", graphKind: "drift", artifactId: "persona-drift:epoch" };
const callback: GraphArtifactRef = { kind: "character_state", graphKind: "callback", artifactId: "memory-1" };
interface State { output: string; proof: ContextProvenance }
interface Channel {
  older: State; newer: State; scheduled: State; revoke: (messageId: string) => Promise<unknown>; open: () => Promise<GuardedConversationContext>;
}

// Drift was built twice from the mood message, so the graph holds two versions; a callback was scheduled
// from the exam message. A later turn sees none of those messages in its window.
async function channel(modes: string): Promise<Channel> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-state-"))); close.push(() => connection.close());
  const graph = new SqliteProvenanceGraphStore(connection.database);
  const revocations = new SqliteMessageRevocationStore(connection.database);
  const gate = new ProvenanceAdmissionGate(graph, parseProvenanceReaderModes(modes));
  const writer = new ProvenanceShadowWriter(graph);
  const fixture = guardedFixture(guardedEvent("mood", 1_000, "I'm in a cheerful mood"));
  fixture.add(guardedEvent("exam", 1_100, "my exam is on Friday"));
  fixture.port.sourcesAllowed = vi.fn((sources: readonly CitedSource[]) => Promise.resolve(sources.map(() => true)));
  fixture.port.revoked = (ids): Promise<readonly boolean[]> => revocations.revoked(ids.map((messageId) => ({ guildId: "guild", channelId: "channel", messageId })));
  fixture.port.graph = { mode: (kind): ProvenanceReaderMode => gate.mode(kind),
    decide: (kind, candidates, audienceUserId): Promise<ProvenanceDecision[]> => gate.decideDetailed(kind, { guildId: "guild", channelId: "channel", audienceUserId }, candidates) };
  const window = { count: 0, budget: 4_000, burstIds: [] };
  const build = async (source: string, ref: GraphArtifactRef, output: string, at: number): Promise<State> => {
    fixture.port.sourceMessageId = source;
    const lease = await GuardedConversationContext.open(fixture.port, window);
    const proof = lease.provenance(output, "character_state")!;
    expect(await writer.recordArtifact({ kind: ref.graphKind, artifactId: ref.artifactId, proof, inputs: lease.graphInputs(), at })).toBe("published");
    return { output, proof };
  };
  const older = await build("mood", drift, "drift: cheerful", 2_000);
  const newer = await build("mood", drift, "drift: cheerful and curious", 3_000);
  const scheduled = await build("exam", callback, "callback: ask about the exam", 3_100);
  fixture.add(guardedEvent("query", 9_000, "how are you?")); fixture.port.sourceMessageId = "query";
  return { older, newer, scheduled, revoke: (messageId) => revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: [messageId], revokedAt: 9_500 }),
    open: () => GuardedConversationContext.open(fixture.port, window) };
}

const admits = (lease: GuardedConversationContext, state: State, ref: GraphArtifactRef | "own"): Promise<boolean> =>
  lease.derived(state.proof, state.output, "character_state", ref);

describe("character state reads through the provenance graph", () => {
  it("rejects a stale drift version and admits the current one as one graph input", async () => {
    const { older, newer, open } = await channel("character_state=v2");
    const lease = await open();
    expect(await admits(lease, older, drift)).toBe(false);
    expect(await admits(lease, newer, drift)).toBe(true);
    const proof = lease.provenance("Hi!")!;
    expect(proof.dependencies.map((dependency) => dependency.messageId)).not.toContain("mood");
    expect(proof.unresolved).toEqual(["graph_ancestry"]);
  });

  it("rejects a callback with a revoked dependency and keeps independently valid drift", async () => {
    const { newer, scheduled, revoke, open } = await channel("character_state=v2");
    expect(await admits(await open(), scheduled, callback)).toBe(true);
    await revoke("exam");
    const lease = await open();
    expect(await admits(lease, scheduled, callback)).toBe(false);
    expect(await admits(lease, newer, drift)).toBe(true);
  });

  it("stops the next model call when the drift's source is revoked mid-turn", async () => {
    const { newer, revoke, open } = await channel("character_state=v2");
    const lease = await open();
    expect(await admits(lease, newer, drift)).toBe(true);
    await revoke("mood");
    expect(await lease.validate("use")).toBe(false);
  });

  it("accepts an output the lease built on its own graph ancestry only as its own", async () => {
    const { newer, open } = await channel("character_state=v2");
    const lease = await open();
    expect(await admits(lease, newer, drift)).toBe(true);
    const next: State = { output: "drift: cheerful, curious and calm", proof: lease.provenance("drift: cheerful, curious and calm", "character_state")! };
    expect(next.proof.unresolved).toEqual(["graph_ancestry"]);
    expect(await admits(lease, next, "own")).toBe(true);
    // Another lease without that ancestry, or a v1 reader, cannot take it as its own.
    expect(await admits(await open(), next, "own")).toBe(false);
  });

  it("keeps the v1 path, which knows no versions, when character state reads v1", async () => {
    const { older, newer, open } = await channel("");
    const lease = await open();
    expect(await admits(lease, older, drift)).toBe(true);
    expect(await admits(lease, newer, drift)).toBe(true);
    expect(lease.provenance("Hi!")!.coverage).toBe("complete");
  });
});
