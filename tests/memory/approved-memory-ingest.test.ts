import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveMemoryIngest, approveRelationIngest } from "../../src/application/context/approved-memory-ingest.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import type { MemoryIngestInput } from "../../src/application/memory/memory.js";
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture(): Promise<{ input: MemoryIngestInput; engine: DefaultMemoryEngine; repository: SqliteMemoryRepository;
  source: ReturnType<typeof guardedFixture>; embed: ReturnType<typeof vi.fn<EmbeddingsClient["embed"]>> }> {
  const source = guardedFixture(guardedEvent("current", 1000, "I like apples"));
  const context = await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] });
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "approved-ingest-"))); cleanups.push(() => connection.close());
  const repository = new SqliteMemoryRepository(connection.database);
  const embed = vi.fn<EmbeddingsClient["embed"]>(() => Promise.resolve([1, 0]));
  const engine = new DefaultMemoryEngine(repository, { modelId: "fixture", embed });
  const input: MemoryIngestInput = { guildId: "guild", channelId: "channel", channelMode: "shared", assertedByUserId: "alice",
    sourceMessageId: "current", sourceTimestampMs: 1000, source: "live", now: 2000, context,
    proposals: [{ action: "upsert", audience: "private", ownerUserId: "alice", subjectType: "member", subjectId: "alice", kind: "preference",
      topic: "preference", slot: "food.fruit", statement: "likes apples", sourceQuote: "I like apples", channelScoped: true }] };
  return { input, engine, repository, source, embed };
}

describe("registered memory-write batches", () => {
  it.each(["raw", "copy", "scope_override"] as const)("rejects a %s batch despite its valid source lease", async (kind) => {
    const { input, engine, embed, repository } = await fixture();
    const batch = kind === "raw" ? input : { ...approveMemoryIngest(input), ...(kind === "scope_override" ? { source: "administrator" as const } : {}) };
    await expect(engine.ingest(batch)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(embed).not.toHaveBeenCalled(); expect(await repository.listBySubject("guild", "alice")).toEqual([]);
  });
  it("pins proposal text and write scope before external embedding or persistence", async () => {
    const { input, engine, embed, repository } = await fixture(); const batch = approveMemoryIngest(input);
    const proposal = input.proposals[0]!; if (proposal.action !== "upsert") throw new Error("fixture"); proposal.statement = "PRIVATE_APPENDED_STATEMENT";
    input.source = "administrator";
    expect(() => { batch.channelId = "other"; }).toThrow();
    expect(() => { (batch.proposals as unknown[]).push(proposal); }).toThrow();
    expect((await engine.ingest(batch)).ingested).toHaveLength(1);
    expect(embed.mock.calls[0]?.[0]).toBe("likes apples");
    expect((await repository.listBySubject("guild", "alice"))[0]?.statement).toBe("likes apples");
  });
  it.each(["before_embedding", "during_embedding"] as const)("does not persist revoked evidence: %s", async (phase) => {
    const { input, engine, embed, repository, source } = await fixture(); const batch = approveMemoryIngest(input);
    if (phase === "before_embedding") source.denied.add("current");
    else embed.mockImplementation(() => { source.denied.add("current"); return Promise.resolve([1, 0]); });
    if (phase === "before_embedding") await expect(engine.ingest(batch)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    else expect(await engine.ingest(batch)).toMatchObject({ ingested: [], failed: 1 });
    expect(embed).toHaveBeenCalledTimes(phase === "before_embedding" ? 0 : 1);
    expect(await repository.listBySubject("guild", "alice")).toEqual([]);
  });
  it("cannot issue authority for a different destination or an administrator proposal", async () => {
    const { input } = await fixture();
    expect(() => approveMemoryIngest({ ...input, channelId: "other" })).toThrow(SocialOutputSuppressed);
    expect(() => approveMemoryIngest({ ...input, source: "administrator" })).toThrow(SocialOutputSuppressed);
  });
  it("also rejects raw or copied relationship batches", async () => {
    const { input, engine } = await fixture();
    const relation = { guildId: "guild", channelId: "channel", channelMode: "shared" as const, context: input.context!,
      supportingMemoryId: null, now: 2000, proposals: [] };
    await expect(engine.ingestRelations(relation)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    const approved = approveRelationIngest(relation);
    await expect(engine.ingestRelations({ ...approved })).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(() => { approved.channelId = "other"; }).toThrow();
  });
});
