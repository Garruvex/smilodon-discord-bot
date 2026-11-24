import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hashContent } from "../../src/application/assets/content-hash.js";
import { bindProvenanceOutput, contextProvenanceLimits, type ContextProvenance } from "../../src/application/chat/context-provenance.js";
import { GuardedConversationContext, type CitedSource } from "../../src/application/chat/guarded-conversation-context.js";
import { ProvenanceAdmissionGate, type ProvenanceDecision, type ProvenanceReaderMode } from "../../src/application/provenance/provenance-admission.js";
import { ProvenanceShadowWriter } from "../../src/application/provenance/provenance-shadow.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const policy = { count: 40, budget: 12000, burstIds: [] };
const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

// The production shape from 2026-11-23: 30 recent human messages and 4 recent bot replies, each reply
// citing 30 older messages outside the window. v1 carries every citation and has to drop replies;
// the graph keeps their ancestry, so each reply costs one input.
interface Channel { fixture: ReturnType<typeof guardedFixture>; revocations: SqliteMessageRevocationStore; writer: ProvenanceShadowWriter; setMode: (mode: ProvenanceReaderMode) => void }
async function channel(input: { mode: ProvenanceReaderMode; overlap?: boolean; forgotten?: (source: CitedSource) => boolean }): Promise<Channel> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-history-"))); close.push(() => connection.close());
  const graph = new SqliteProvenanceGraphStore(connection.database);
  const revocations = new SqliteMessageRevocationStore(connection.database);
  let mode = input.mode;
  const gate = new ProvenanceAdmissionGate(graph, () => mode);
  const fixture = guardedFixture(guardedEvent("current", 100_000, "<@bot> hi"));
  const allowed = vi.fn((sources: readonly CitedSource[]) => Promise.resolve(sources.map((source) => !input.forgotten?.(source))));
  fixture.port.sourcesAllowed = allowed;
  fixture.port.revoked = (ids): Promise<readonly boolean[]> => revocations.revoked(ids.map((messageId) => ({ guildId: "guild", channelId: "channel", messageId })));
  fixture.port.graph = { mode: (kind): ProvenanceReaderMode => gate.mode(kind),
    decide: (kind, candidates, audienceUserId): Promise<ProvenanceDecision[]> => gate.decideDetailed(kind, { guildId: "guild", channelId: "channel", audienceUserId }, candidates) };
  const template = (await GuardedConversationContext.open(fixture.port, policy)).provenance("template")!;
  for (let index = 0; index < 30; index++) fixture.add(guardedEvent(`human-${index}`, 10_000 + index, `message ${index}`));
  const writer = new ProvenanceShadowWriter(graph);
  for (let reply = 0; reply < 4; reply++) {
    const content = `bot answer ${reply}`;
    const cited = (index: number): string => input.overlap ? `cited-${index}` : `cited-${reply}-${index}`;
    const dependencies = Array.from({ length: 30 }, (_unused, index) => ({ guildId: "guild", channelId: "channel", messageId: cited(index), authorId: "alice",
      timestampMs: 1_000 + (input.overlap ? 0 : reply * 100) + index, representationHash: hashContent(cited(index)) }));
    const proof: ContextProvenance = { ...template, outputHash: hashContent(content), dependencies };
    fixture.sources.set(`bot-${reply}`, { event: guardedEvent(`bot-${reply}`, 50_000 + reply, content, "bot"), origin: "chat", provenance: proof });
    expect(await writer.recordReplyPart({ guildId: "guild", channelId: "channel", messageId: `bot-${reply}`, origin: "chat", contextProvenance: proof, createdAt: 60_000 + reply } as never,
      dependencies.map((dependency) => ({ messageId: dependency.messageId, origin: "human", direct: true, carriers: [] })))).toBe("published");
  }
  return { fixture, revocations, writer, setMode: (next: ProvenanceReaderMode): void => { mode = next; } };
}

const kept = (lease: GuardedConversationContext, prefix: string): string[] => lease.history.map((event) => event.messageId).filter((id) => id.startsWith(prefix));

describe("history reads earlier replies through the provenance graph", () => {
  it.each([["disjoint", false], ["overlapping", true]])("keeps all 30 human messages and all 4 replies in v2 with %s citations", async (_label, overlap) => {
    const { fixture } = await channel({ mode: "v2", overlap });
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(lease, "human-")).toHaveLength(30);
    expect(kept(lease, "bot-")).toEqual(["bot-0", "bot-1", "bot-2", "bot-3"]);
    expect([...lease.history].sort((a, b) => a.timestampMs - b.timestampMs)).toEqual(lease.history);
    // The direct mention still gets a reply proof; each earlier reply is one input, its ancestry in the graph.
    const proof = lease.provenance("answer")!;
    expect(proof).not.toBeNull();
    expect(proof.dependencies.some((dependency) => dependency.messageId.startsWith("cited-"))).toBe(false);
    expect(proof.dependencies.length).toBeLessThanOrEqual(contextProvenanceLimits.dependencies);
    expect(proof.coverage).toBe("partial");
    expect(proof.unresolved).toEqual(["graph_ancestry"]);
    expect(await lease.validate("effect")).toBe(true);
    // A proof the graph reader admits is bound to its output, like a complete one.
    const destination = { guildId: "guild", channelId: "channel" };
    expect(bindProvenanceOutput(proof, "answer", destination)).toEqual(proof);
    expect(bindProvenanceOutput(proof, "other text", destination)).toBeNull();
  });

  it.each(["v1", "shadow"] as const)("keeps v1's behaviour in %s mode: replies give way to the carried limit", async (mode) => {
    const { fixture } = await channel({ mode });
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(lease, "human-")).toHaveLength(30);
    expect(kept(lease, "bot-").length).toBeLessThan(4);
    expect(lease.provenance("answer")!.coverage).toBe("complete");
  });

  it("drops a reply whose ancestor is revoked, and one whose ancestor's author has been forgotten", async () => {
    const { fixture, revocations } = await channel({ mode: "v2", forgotten: (source) => source.messageId.startsWith("cited-1-") });
    await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["cited-2-5"], revokedAt: 99_000 });
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(lease, "bot-")).toEqual(["bot-0", "bot-3"]);
    expect(kept(lease, "human-")).toHaveLength(30);
  });

  it("stops the next model call and effect when an ancestor is revoked mid-turn", async () => {
    const { fixture, revocations } = await channel({ mode: "v2" });
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(await lease.validate("use")).toBe(true);
    await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["cited-3-0"], revokedAt: 99_000 });
    expect(await lease.validate("use")).toBe(false);
  });

  it("re-checks forget and opt-out on the ancestors at an effect", async () => {
    let forget = false;
    const { fixture } = await channel({ mode: "v2", forgotten: (source) => forget && source.messageId === "cited-0-0" });
    const lease = await GuardedConversationContext.open(fixture.port, policy);
    expect(await lease.validate("effect")).toBe(true);
    forget = true;
    expect(await lease.validate("effect")).toBe(false);
  });

  it("hides a reply built on graph ancestry from v1 readers after a rollback", async () => {
    const { fixture, writer, setMode } = await channel({ mode: "v2" });
    const turn = await GuardedConversationContext.open(fixture.port, policy);
    const answer = turn.provenance("graph answer")!;
    expect(await writer.recordReplyPart({ guildId: "guild", channelId: "channel", messageId: "bot-graph", origin: "chat", contextProvenance: answer, createdAt: 90_000 } as never,
      turn.graphInputs())).toBe("published");
    fixture.sources.set("bot-graph", { event: guardedEvent("bot-graph", 90_000, "graph answer", "bot"), origin: "chat", provenance: answer });
    expect(kept(await GuardedConversationContext.open(fixture.port, policy), "bot-graph")).toEqual(["bot-graph"]);
    setMode("v1");
    const rolledBack = await GuardedConversationContext.open(fixture.port, policy);
    expect(kept(rolledBack, "bot-graph")).toEqual([]);
    expect(rolledBack.provenance("answer")!.coverage).toBe("complete");
  });
});
