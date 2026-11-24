import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatSessionExchange } from "../../src/application/chat/chat-state-store.js";
import { GuardedConversationContext, type CitedSource } from "../../src/application/chat/guarded-conversation-context.js";
import { ProvenanceAdmissionGate, parseProvenanceReaderModes, type ProvenanceDecision, type ProvenanceReaderMode } from "../../src/application/provenance/provenance-admission.js";
import { ProvenanceShadowWriter } from "../../src/application/provenance/provenance-shadow.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

interface Session { fixture: ReturnType<typeof guardedFixture>; revocations: SqliteMessageRevocationStore; exchange: ChatSessionExchange; open: () => Promise<GuardedConversationContext> }

// Alice asked a question 30 messages into a conversation; the bot answered in two parts. The exchange has
// since left the recent window. Its proof cites all 31 messages; each delivered part is in the graph.
async function session(modes: string, input: { graphParts?: boolean; forgotten?: (source: CitedSource) => boolean } = {}): Promise<Session> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-session-"))); close.push(() => connection.close());
  const graph = new SqliteProvenanceGraphStore(connection.database);
  const revocations = new SqliteMessageRevocationStore(connection.database);
  const gate = new ProvenanceAdmissionGate(graph, parseProvenanceReaderModes(modes));
  const fixture = guardedFixture(guardedEvent("question", 1_000, "what did we decide?"));
  for (let index = 0; index < 30; index++) fixture.add(guardedEvent(`cited-${index}`, 100 + index, `earlier ${index}`));
  fixture.port.sourcesAllowed = vi.fn((sources: readonly CitedSource[]) => Promise.resolve(sources.map((source) => !input.forgotten?.(source))));
  fixture.port.revoked = (ids): Promise<readonly boolean[]> => revocations.revoked(ids.map((messageId) => ({ guildId: "guild", channelId: "channel", messageId })));
  fixture.port.graph = { mode: (kind): ProvenanceReaderMode => gate.mode(kind),
    decide: (kind, candidates, audienceUserId): Promise<ProvenanceDecision[]> => gate.decideDetailed(kind, { guildId: "guild", channelId: "channel", audienceUserId }, candidates) };
  const prior = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12_000, burstIds: [] });
  const writer = new ProvenanceShadowWriter(graph);
  const parts = [["part-a", "We decided "], ["part-b", "on Friday."]] as const;
  for (const [index, [id, content]] of parts.entries()) {
    const proof = prior.provenance(content)!;
    fixture.sources.set(id, { event: guardedEvent(id, 2_000 + index, content, "bot"), origin: "chat", provenance: proof });
    if (input.graphParts !== false) {
      expect(await writer.recordReplyPart({ guildId: "guild", channelId: "channel", messageId: id, origin: "chat", contextProvenance: proof, createdAt: 2_000 + index } as never,
        prior.graphInputs())).toBe("published");
    }
  }
  const exchange: ChatSessionExchange = { user: { content: "what did we decide?", createdAt: 1_000, sourceMessageId: "question" },
    assistant: { content: "We decided on Friday.", createdAt: 2_001, messageIds: ["part-a", "part-b"] }, contextProvenance: prior.provenance("We decided on Friday.") };
  // Newer chatter pushes the exchange out of the recent window.
  for (let index = 0; index < 5; index++) fixture.add(guardedEvent(`recent-${index}`, 50_000 + index, `later ${index}`, "bob"));
  fixture.add(guardedEvent("current", 100_000, "and who's bringing food?")); fixture.port.sourceMessageId = "current";
  return { fixture, revocations, exchange, open: () => GuardedConversationContext.open(fixture.port, { count: 3, budget: 12_000, burstIds: [] }) };
}

const ids = (lease: GuardedConversationContext): string[] => lease.provenance("answer")!.dependencies.map((dependency) => dependency.messageId);

describe("sessions read their delivered parts through the provenance graph", () => {
  it("reuses an exchange missing from recent history, with each part as one input", async () => {
    const { exchange, open } = await session("session=v2");
    const lease = await open();
    expect(lease.history.map((event) => event.messageId)).not.toContain("part-a");
    expect(await lease.sessions([exchange])).toEqual([exchange]);
    const proof = lease.provenance("answer")!;
    expect(ids(lease)).toEqual(expect.arrayContaining(["part-a", "part-b", "question"]));
    expect(ids(lease).some((id) => id.startsWith("cited-"))).toBe(false);
    expect(proof.coverage).toBe("partial");
    expect(proof.unresolved).toEqual(["graph_ancestry"]);
    expect(await lease.validate("effect")).toBe(true);
  });

  it.each(["", "session=shadow"])("keeps the flattened v1 path with modes %j", async (modes) => {
    const { exchange, open } = await session(modes);
    const lease = await open();
    expect(await lease.sessions([exchange])).toEqual([exchange]);
    expect(ids(lease).filter((id) => id.startsWith("cited-"))).toHaveLength(30);
    expect(lease.provenance("answer")!.coverage).toBe("complete");
  });

  it("keeps the v1 path for parts the graph does not have", async () => {
    const { exchange, open } = await session("session=v2", { graphParts: false });
    const lease = await open();
    expect(await lease.sessions([exchange])).toEqual([exchange]);
    expect(lease.provenance("answer")!.coverage).toBe("complete");
  });

  it.each([
    ["a delivered part is removed", (s: Session): void => { s.fixture.sources.delete("part-b"); }],
    ["a delivered part's text changed", (s: Session): void => { s.fixture.sources.get("part-a")!.event.content = "We decided nothing."; }],
    ["the original input is revoked", async (s: Session): Promise<void> => { await s.revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["question"], revokedAt: 99_000 }); }],
    ["an ancestor is revoked", async (s: Session): Promise<void> => { await s.revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["cited-7"], revokedAt: 99_000 }); }],
    ["the original input is deleted", (s: Session): void => { s.fixture.sources.delete("question"); }],
    ["another person asks", (s: Session): void => { s.fixture.add(guardedEvent("current", 100_000, "hi", "bob")); s.fixture.port.actorId = "bob"; }],
  ])("excludes the exchange when %s", async (_label, change) => {
    const current = await session("session=v2");
    await Promise.resolve(change(current));
    expect(await (await current.open()).sessions([current.exchange])).toEqual([]);
  });

  it("excludes the exchange when an ancestor's author has been forgotten", async () => {
    const { exchange, open } = await session("session=v2", { forgotten: (source) => source.messageId === "cited-3" });
    expect(await (await open()).sessions([exchange])).toEqual([]);
  });

  it("re-checks the parts under the session reader when an ancestor is revoked mid-turn", async () => {
    // reply_part stays on v1: the re-check must ask the reader kind that admitted the parts.
    const { exchange, revocations, open } = await session("session=v2,reply_part=v1");
    const lease = await open();
    expect(await lease.sessions([exchange])).toEqual([exchange]);
    expect(await lease.validate("use")).toBe(true);
    await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["cited-0"], revokedAt: 99_000 });
    expect(await lease.validate("use")).toBe(false);
  });
});
