import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashContent } from "../../src/application/assets/content-hash.js";
import type { ChatProvider } from "../../src/application/chat/chat-provider.js";
import type { ChatSessionExchange } from "../../src/application/chat/chat-state-store.js";
import type { GuardedChatConversationInput } from "../../src/application/chat/chat-conversation-service.js";
import type { ContextProvenance } from "../../src/application/chat/context-provenance.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { guardedToolResourcePort } from "../../src/application/chat/guarded-tool-gateway.js";
import { runGuardedPostTurn } from "../../src/application/chat/guarded-post-turn.js";
import { PersonaDriftStore } from "../../src/application/chat/persona-drift-store.js";
import { conversationConfiguration } from "../../src/application/context/conversation-configuration.js";
import { ConversationModelGateway } from "../../src/application/context/conversation-model-gateway.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { ProvenanceShadowWriter } from "../../src/application/provenance/provenance-shadow.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import * as schema from "../../src/infrastructure/database/sqlite-schema.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";
import { decisionRequest } from "../helpers/conversation-decision-fixtures.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

function storage(): { connection: ReturnType<typeof createSqliteDatabaseConnection>; graph: SqliteProvenanceGraphStore; writer: ProvenanceShadowWriter; revocations: SqliteMessageRevocationStore;
  outputHash: (kind: Parameters<SqliteProvenanceGraphStore["current"]>[2], artifactId: string, channelId?: string) => Promise<string | null> } {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-artifacts-"))); close.push(() => connection.close());
  const graph = new SqliteProvenanceGraphStore(connection.database);
  return { connection, graph, writer: new ProvenanceShadowWriter(graph), revocations: new SqliteMessageRevocationStore(connection.database),
    outputHash: async (kind, artifactId, channelId = "channel"): Promise<string | null> => {
      const current = await graph.current("guild", channelId, kind, artifactId); if (!current) return null;
      return connection.database.select({ outputHash: schema.provenanceRevisions.outputHash }).from(schema.provenanceRevisions)
        .where(eq(schema.provenanceRevisions.id, current.revisionId)).get()?.outputHash ?? null;
    } };
}

const proof = (purpose: NonNullable<ContextProvenance["purpose"]>, output: string, sources: readonly string[]): ContextProvenance => ({
  version: 1, purpose, coverage: "complete", audience: { guildId: "guild", channelId: "channel", userId: null }, outputHash: hashContent(output), unresolved: [],
  dependencies: sources.map((messageId) => ({ guildId: "guild", channelId: "channel", messageId, authorId: "alice", timestampMs: 1, representationHash: hashContent(messageId) })),
});

describe("ProvenanceShadowWriter artifacts", () => {
  it.each([["claim", "memory_claim"], ["alias", "identity_alias"], ["relation", "relation"], ["callback", "character_state"], ["drift", "character_state"]] as const)(
    "versions a %s by output and links exactly its own sources", async (kind, purpose) => {
      const { graph, writer, outputHash } = storage();
      expect(await writer.recordArtifact({ kind, artifactId: "a1", proof: proof(purpose, "first", ["m1", "m2"]), inputs: "background", at: 1_000 })).toBe("published");
      expect(await graph.current("guild", "channel", kind, "a1")).toMatchObject({ version: 1 });
      expect(await outputHash(kind, "a1")).toBe(hashContent("first"));
      expect(await writer.recordArtifact({ kind, artifactId: "a1", proof: proof(purpose, "second", ["m3"]), inputs: "background", at: 2_000 })).toBe("published");
      const current = (await graph.current("guild", "channel", kind, "a1"))!;
      expect(current.version).toBe(2);
      expect(await outputHash(kind, "a1")).toBe(hashContent("second"));
      const messages = await graph.currentMany("guild", "channel", "message", ["m3"]);
      expect((await graph.parents(current.revisionId)).map((parent) => parent.revisionId)).toEqual([messages.get("m3")]);
    });

  it("gives a claim and the alias nested in it their own source sets", async () => {
    const { graph, writer } = storage();
    await writer.recordArtifact({ kind: "claim", artifactId: "memory", proof: proof("memory_claim", "likes tea", ["said-tea"]), inputs: "background", at: 1_000 });
    await writer.recordArtifact({ kind: "alias", artifactId: "memory/Ally", proof: proof("identity_alias", "Ally", ["called-ally"]), inputs: "background", at: 1_000 });
    const messages = await graph.currentMany("guild", "channel", "message", ["said-tea", "called-ally"]);
    const parentsOf = async (kind: "claim" | "alias", id: string): Promise<string[]> =>
      (await graph.parents((await graph.current("guild", "channel", kind, id))!.revisionId)).map((parent) => parent.revisionId);
    expect(await parentsOf("claim", "memory")).toEqual([messages.get("said-tea")]);
    expect(await parentsOf("alias", "memory/Ally")).toEqual([messages.get("called-ally")]);
  });
});

async function postTurn(): Promise<{ fixture: ReturnType<typeof guardedFixture>; exchange: ChatSessionExchange; input: GuardedChatConversationInput }> {
  const fixture = guardedFixture(guardedEvent("original", 1000, "I like green apples"));
  fixture.port.shareMemory = true;
  const original = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 0, burstIds: [] });
  const delivered = original.provenance("Understood")!;
  fixture.sources.set("delivered", { event: guardedEvent("delivered", 2000, "Understood", "bot"), origin: "chat", provenance: delivered });
  const exchange: ChatSessionExchange = { user: { content: "I like green apples", createdAt: 1000, sourceMessageId: "original", channelMemoryMode: "shared" },
    assistant: { content: "Understood", createdAt: 2000, messageIds: ["delivered"] }, contextProvenance: delivered };
  fixture.add(guardedEvent("current", 3000, "I like pears")); fixture.port.sourceMessageId = "current";
  const input: GuardedChatConversationInput = { ...decisionRequest({ interaction: "direct_mention", message: "UNTRUSTED_INPUT" }),
    sourceMessageId: "current", guardedContextPort: fixture.port, examplePool: [], loreChunks: [], personaDriftEnabled: true,
    turnPlan: { context: "guarded_text", deadlineMs: 30000, contextPolicy: { count: 0, budget: 0 } } };
  return { fixture, exchange, input };
}

describe("post-turn artifacts dual-write the graph", () => {
  it("records extracted claims and drift, and exposes a drift replacement only after the graph accepts it", async () => {
    const { connection, graph, writer, revocations, outputHash } = storage();
    const { fixture, exchange, input } = await postTurn();
    const memory = new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database), null, null, undefined, null, null, null, () => true);
    memory.observeArtifacts(async (artifact) => { await writer.recordArtifact({ ...artifact, at: 4_000 }); });
    const drift = new PersonaDriftStore(mkdtempSync(join(tmpdir(), "provenance-drift-")));
    drift.bindProvenanceShadow((artifact) => writer.recordArtifact(artifact));
    const provider: ChatProvider = { reply: vi.fn(),
      extractPersonalMemories: () => Promise.resolve([{ action: "upsert", aboutSpeaker: true, topic: "preference", slot: "food.pear", statement: "likes pears", sourceQuote: "I like pears", importance: "low" }]),
      summarizeDroppedExchanges: () => Promise.resolve([]), evolvePersonaDrift: () => Promise.resolve("SOURCE_BACKED_DRIFT") };
    await runGuardedPostTurn(input, [exchange], { provider, utility: null, memory, customization: null, tools: null, drift, logger: null, now: () => 4000, mutate: (operation) => operation() });

    const stored = (await drift.getScoped("guild", "channel"))!;
    expect(stored.text).toBe("SOURCE_BACKED_DRIFT");
    const driftId = `persona-drift:${stored.epoch}`;
    expect(await graph.current("guild", "channel", "drift", driftId)).toMatchObject({ version: 1 });
    expect(await outputHash("drift", driftId)).toBe(stored.contextProvenance.outputHash);
    const claims = connection.database.select({ artifactId: schema.provenanceRevisions.artifactId }).from(schema.provenanceRevisions)
      .where(eq(schema.provenanceRevisions.kind, "claim")).all();
    expect(claims).toHaveLength(1);
    // The session's delivered reply was not in the graph, so its sources come in as direct, flattened edges.
    const driftRevision = connection.database.select().from(schema.provenanceRevisions).where(eq(schema.provenanceRevisions.kind, "drift")).get()!;
    expect(driftRevision.completeness).toBe("flattened");

    // A replacement built on a message the graph has since seen revoked is refused, so the old drift stays.
    await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["original"], revokedAt: 4_500 });
    const resources = guardedToolResourcePort(fixture.port, null, { currentUser: input.currentUser, channelMode: "shared", channelIsNsfw: false, isOwner: false },
      undefined, await conversationConfiguration("guild", "alice", undefined, null), drift);
    const evolve = async (text: string, at: number): Promise<void> => {
      const lease = await GuardedConversationContext.open(resources, { count: 0, budget: 0, burstIds: [] });
      await drift.evolveScoped(lease, new ConversationModelGateway({ reply: vi.fn(), evolvePersonaDrift: (): Promise<string> => Promise.resolve(text) }), [exchange], stored.personalitySourceHash, at);
    };
    await evolve("BUILT_ON_REVOKED", 5_000);
    expect((await drift.getScoped("guild", "channel"))?.text).toBe("SOURCE_BACKED_DRIFT");
    expect(await graph.current("guild", "channel", "drift", driftId)).toMatchObject({ version: 1 });

    // A cleanup retry racing a replacement: whichever runs first, a drift file left behind is the graph's current version.
    await Promise.all([evolve("RACED_REPLACEMENT", 6_000), drift.forgetCitingMessages("guild", "channel", ["original"])]);
    const after = await drift.getScoped("guild", "channel");
    if (after) expect(await outputHash("drift", driftId)).toBe(after.contextProvenance.outputHash);
    expect(after?.text).not.toBe("RACED_REPLACEMENT");
  });
});
