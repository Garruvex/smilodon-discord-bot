import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { retrievalProjection, toolRetrievalQuery } from "../../src/application/context/retrieval-query.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { RelevantExampleExchangeSelector } from "../../src/application/chat/example-exchange-selector.js";
import { RelevantPersonaLoreSelector } from "../../src/application/chat/persona-lore-selector.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { memoryClaimPayload } from "../../src/application/memory/memory-claim-provenance.js";
import { guardedTools } from "../../src/application/chat/guarded-tool-gateway.js";
import { MemoryLookupTool } from "../../src/application/chat/tools/memory-lookup-tool.js";
import { ChatToolRegistry } from "../../src/application/chat/tools/chat-tool-registry.js";
import type { RepositoryIngestInput, MemoryRecallInput } from "../../src/application/memory/memory.js";
import type { ChatToolContext } from "../../src/application/chat/tools/chat-tool.js";
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture(): Promise<{ context: GuardedConversationContext; engine: DefaultMemoryEngine; embed: ReturnType<typeof vi.fn<EmbeddingsClient["embed"]>> }> {
  const source = guardedFixture(guardedEvent("current", 3000, "AUTHORIZED_CURRENT"));
  source.add(guardedEvent("old", 1000, "AUTHORIZED_HISTORY"));
  const context = await GuardedConversationContext.open(source.port, { count: 40, budget: 12000, burstIds: [] });
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "retrieval-query-"))); cleanups.push(() => connection.close());
  const repository = new SqliteMemoryRepository(connection.database);
  const record: RepositoryIngestInput = { guildId: "guild", audience: "channel", ownerUserId: null, channelId: "channel", isolationChannelId: null,
    subjectType: "member", subjectId: "alice", kind: "preference", topic: "preference", slot: "food.fruit", statement: "likes apples",
    status: "active", source: "live", importance: 1, embedding: [1, 0], embeddingModel: "fixture", expiresAt: null, now: 1000,
    assertedByUserId: "alice", sourceMessageId: "old", sourceChannelId: "channel" };
  await repository.ingest({ ...record, contextProvenance: context.provenance(memoryClaimPayload(record), "memory_claim") });
  const embed = vi.fn<EmbeddingsClient["embed"]>((_text: string) => Promise.resolve([1, 0]));
  return { context, engine: new DefaultMemoryEngine(repository, { modelId: "fixture", embed }), embed };
}
function recall(context: GuardedConversationContext): MemoryRecallInput {
  return { guildId: "guild", channelId: "channel", userId: "alice", context, now: 4000, subjectIds: ["alice"],
    message: "PRIVATE_APPENDED_MESSAGE", recentHistory: [{ content: "PRIVATE_APPENDED_SESSION" }], replyToContent: "PRIVATE_APPENDED_PARENT" };
}

describe("source-owned retrieval queries", () => {
  it("retains verified session context outside the selected history window", async () => {
    const source = guardedFixture(guardedEvent("prior", 1000, "AUTHORIZED_SESSION_HUMAN"));
    const original = await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] });
    const proof = original.provenance("AUTHORIZED_SESSION_BOT")!;
    source.sources.set("delivered", { event: guardedEvent("delivered", 2000, "AUTHORIZED_SESSION_BOT", "bot"), origin: "chat", sourceMessageId: "prior", provenance: proof });
    source.add(guardedEvent("current", 3000, "What about that?")); source.port.sourceMessageId = "current";
    const context = await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] });
    expect(context.history).toEqual([]);
    expect(await context.sessions([{ user: { content: "AUTHORIZED_SESSION_HUMAN", createdAt: 1000, sourceMessageId: "prior", channelMemoryMode: "shared" },
      assistant: { content: "AUTHORIZED_SESSION_BOT", createdAt: 2000, messageIds: ["delivered"] }, contextProvenance: proof }])).toHaveLength(1);
    expect(retrievalProjection(context).recentHistory).toEqual([{ content: "AUTHORIZED_SESSION_HUMAN" }, { content: "AUTHORIZED_SESSION_BOT" }]);
    source.denied.add("prior"); expect(await context.validate()).toBe(false);
  });
  it("ignores appended query/history text across memory, example and lore embeddings", async () => {
    const { context, engine, embed } = await fixture();
    await engine.recall(recall(context));
    const client = { modelId: "fixture", embed };
    const input = { context, message: "PRIVATE_APPENDED_MESSAGE", recentHistory: [{ content: "PRIVATE_APPENDED_SESSION" }], now: 4000,
      replyChain: [{ content: "PRIVATE_APPENDED_PARENT" }] };
    await new RelevantExampleExchangeSelector(client).select({ ...input, currentUser: { id: "alice", displayName: "Alice", roleNames: [] }, mentionedUsers: [],
      records: [{ tags: "fruit", user: "apples", character: "yes", embedding: [1, 0] }] });
    await new RelevantPersonaLoreSelector(client).select({ ...input, replyChainSummary: "PRIVATE_APPENDED_SUMMARY",
      chunks: [{ heading: "fruit", text: "apples", embedding: [1, 0] }] });
    expect(embed).toHaveBeenCalledTimes(3);
    for (const call of embed.mock.calls) { expect(call[0]).toContain("AUTHORIZED_CURRENT"); expect(call[0]).toContain("AUTHORIZED_HISTORY"); expect(call[0]).not.toContain("PRIVATE_APPENDED"); }
    expect(new Set(embed.mock.calls.map((call) => call[0])).size).toBe(1);
  });
  it.each(["guildId", "channelId", "userId"] as const)("rejects a mismatched %s before embedding", async (key) => {
    const { context, engine, embed } = await fixture();
    await expect(engine.recall({ ...recall(context), [key]: "other" })).rejects.toBeInstanceOf(Error);
    expect(embed).not.toHaveBeenCalled();
  });
  it("binds tool-query receipts to one lease and rejects copied receipts", async () => {
    const { context } = await fixture(); const { context: other } = await fixture();
    const query = toolRetrievalQuery(context, " apples ");
    expect(retrievalProjection(context, query)).toEqual({ message: "apples", recentHistory: [], replyToContent: "" });
    expect(() => retrievalProjection(other, query)).toThrow(); expect(() => retrievalProjection(context, { ...query })).toThrow();
  });
  it("admits model-derived search text only through the reviewed executor", async () => {
    const { context, engine, embed } = await fixture();
    const tool = new MemoryLookupTool(engine); const scope = { enabled: true, guildId: "guild", channelId: "channel", userId: "alice" };
    const check = async (): Promise<void> => { if (!await context.validate()) throw new Error("stale"); };
    const registered = guardedTools(new ChatToolRegistry([tool]), context, scope, check, () => undefined);
    const input: ChatToolContext = { guildId: "guild", channelId: "channel", currentUser: { id: "alice", displayName: "Alice", roleNames: [] },
      channelIsNsfw: false, channelMode: "shared", isOwner: false, contextLease: context, music: null, pendingGeneratedImages: [] };
    await registered[0]!.execute({ query: "apples", scope: "search" }, input);
    expect(embed.mock.calls[0]?.[0]).toBe("apples");
    embed.mockClear(); await tool.execute({ query: "UNREGISTERED_QUERY", scope: "search" }, input);
    expect(embed.mock.calls[0]?.[0]).toContain("AUTHORIZED_CURRENT"); expect(embed.mock.calls[0]?.[0]).not.toContain("UNREGISTERED_QUERY");
  });
  it("does not spend an embedding call on a broad list without a search query", async () => {
    const { context, engine, embed } = await fixture();
    await engine.recall({ ...recall(context), query: toolRetrievalQuery(context, ""), onlySelfSubjectMemories: true });
    expect(embed).not.toHaveBeenCalled();
  });
});
