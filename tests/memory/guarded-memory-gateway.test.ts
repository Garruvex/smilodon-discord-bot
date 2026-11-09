import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuardedMemoryEngine } from "../../src/application/context/guarded-memory-gateway.js";
import { approveMemoryIngest } from "../../src/application/context/approved-memory-ingest.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { memoryClaimPayload } from "../../src/application/memory/memory-claim-provenance.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import type { MemoryIngestInput, RepositoryIngestInput } from "../../src/application/memory/memory.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function fixture(persist = true): Promise<{
  gateway: ReturnType<typeof createGuardedMemoryEngine>; repository: SqliteMemoryRepository; context: GuardedConversationContext; input: MemoryIngestInput;
  embed: ReturnType<typeof vi.fn<(text: string) => Promise<number[]>>>;
}> {
  const source = guardedFixture(guardedEvent("current", 1000, "I like apples")); source.port.persist = persist;
  const context = await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] });
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "memory-gateway-"))); cleanups.push(() => connection.close());
  const repository = new SqliteMemoryRepository(connection.database); const embed = vi.fn((_text: string) => Promise.resolve([1, 0]));
  const gateway = createGuardedMemoryEngine(repository, { modelId: "fixture", embed }, null, undefined, null, null, null, () => true, () => null, () => 3000);
  return { gateway, repository, context, embed, input: { guildId: "guild", channelId: "channel", channelMode: "shared", assertedByUserId: "alice", sourceMessageId: "current",
    sourceTimestampMs: 1000, source: "live", now: 2000, context, proposals: [{ action: "upsert", audience: "guild", ownerUserId: null, subjectType: "member",
      subjectId: "alice", kind: "preference", topic: "preference", slot: "fruit", statement: "likes apples", channelScoped: true }] } };
}

describe("mandatory production memory gateway", () => {
  it("exposes a frozen facade and rejects context-free core compatibility before reads, models or writes", async () => {
    const { gateway, repository, input, embed } = await fixture(); const read = vi.spyOn(repository, "findRecallCandidates");
    const sweep = vi.spyOn(repository, "deleteExpiredCandidates");
    expect(Object.isFrozen(gateway)).toBe(true); expect("core" in gateway).toBe(false);
    const { context: _context, ...raw } = input;
    await expect(gateway.ingest(raw)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    await expect(gateway.ingestRelations({ guildId: "guild", channelId: "channel", channelMode: "shared", proposals: [], supportingMemoryId: null, now: 2000 })).rejects.toBeInstanceOf(SocialOutputSuppressed);
    await expect(gateway.recall({ guildId: "guild", channelId: "channel", userId: "alice", message: "raw", recentHistory: [], subjectIds: [], now: 2000 })).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(read).not.toHaveBeenCalled(); expect(sweep).not.toHaveBeenCalled(); expect(embed).not.toHaveBeenCalled();
  });
  it("permits a registered write without exposing the core", async () => {
    const { gateway, input } = await fixture();
    expect((await gateway.ingest(approveMemoryIngest(input))).ingested).toHaveLength(1);
  });
  it("uses the composition clock so callers cannot resurrect expired claims", async () => {
    const { gateway, context, repository, embed } = await fixture();
    const record: RepositoryIngestInput = { guildId: "guild", channelId: "channel", isolationChannelId: null, audience: "channel", ownerUserId: null,
      subjectType: "member", subjectId: "alice", kind: "fact", topic: "preference", slot: "fruit", statement: "EXPIRED_CLAIM", status: "active", source: "live",
      importance: 1, embedding: [1, 0], embeddingModel: "fixture", expiresAt: 2000, now: 1000, sourceMessageId: "current", sourceChannelId: "channel", assertedByUserId: "alice" };
    await repository.ingest({ ...record, contextProvenance: context.provenance(memoryClaimPayload(record), "memory_claim") });
    const result = await gateway.recall({ guildId: "guild", channelId: "channel", userId: "alice", message: "EXPIRED_CLAIM", recentHistory: [], subjectIds: ["alice"], now: 1000, context });
    expect(result.memories).toEqual([]); expect(embed).not.toHaveBeenCalled();
  });
  it("cannot override session/disabled retention by claiming shared mode", async () => {
    const { gateway, input, context, embed } = await fixture(false);
    await expect(gateway.ingest(approveMemoryIngest(input))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(await gateway.recall({ guildId: "guild", channelId: "channel", userId: "alice", message: "apples", recentHistory: [], subjectIds: ["alice"], now: 2000, channelMode: "shared", context })).toEqual({ memories: [], causalChains: [] });
    expect(embed).not.toHaveBeenCalled();
  });
});
