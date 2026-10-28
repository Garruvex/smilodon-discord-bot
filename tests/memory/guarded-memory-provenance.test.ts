import { fixtureMemoryIngest } from "../helpers/approved-memory-fixture.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { GuardedBackgroundContext } from "../../src/application/context/guarded-background-context.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { memoryClaimProof } from "../../src/application/memory/memory-claim-provenance.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import type { MemoryIngestInput } from "../../src/application/memory/memory.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });
const source = { id: "original", guildId: "guild", channelId: "channel", authorId: "alice", authorDisplayName: "alice", content: "I like green apples", createdAt: 1000 };
const base: MemoryIngestInput = { guildId: "guild", channelId: "channel", channelMode: "shared", source: "consolidation", sourceMessageId: "batch",
  assertedByUserId: "alice", sourceTimestampMs: 1000, now: 2000, proposals: [{ action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
    subjectType: "member", subjectId: "alice", topic: "preference", slot: "food.fruit", statement: "likes green apples", channelScoped: true }] };

async function setup(shared = true): Promise<{ engine: DefaultMemoryEngine; context: GuardedBackgroundContext; fixture: ReturnType<typeof guardedFixture>; deny: () => void }> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "memory-proof-"))); close.push(() => connection.close());
  const engine = new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database), null, null, undefined, null, null, null, () => shared);
  let eligible = true;
  const context = await GuardedBackgroundContext.open("summary", [source], { readBatch: vi.fn(), validateBatch: () => Promise.resolve(eligible) }, () => true);
  const fixture = guardedFixture(guardedEvent("current", 3000, "Which fruit do I like?"));
  fixture.add(guardedEvent(source.id, source.createdAt, source.content));
  return { engine, context, fixture, deny: (): void => { eligible = false; } };
}

describe("durable guarded memory claims", () => {
  it("persists identity-bound, content-free source manifests and recalls through a fresh lease", async () => {
    const { engine, context, fixture } = await setup();
    const stored = await engine.ingest(fixtureMemoryIngest({ ...base, context }));
    const row = stored.ingested[0]!;
    expect(row.contextProvenance?.purpose).toBe("memory_claim");
    expect(row.contextProvenance?.dependencies[0]).toMatchObject({ messageId: "original", projection: { kind: "background_text" } });
    expect(JSON.stringify(row.contextProvenance)).not.toContain("green apples");
    expect(memoryClaimProof(row.contextProvenance, { ...row, subjectId: "bob" })).toBeNull();
    const lease = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 12000, burstIds: [] });
    const recalled = await engine.recall({ guildId: "guild", channelId: "channel", userId: "alice", message: "apples", recentHistory: [], subjectIds: ["alice"], now: 4000, context: lease });
    expect(recalled.memories.map((memory) => memory.statement)).toEqual(["likes green apples"]);
    expect(lease.provenance("answer")?.dependencies.map((dependency) => dependency.messageId)).toContain("original");
    fixture.denied.add("original"); expect(await lease.validate()).toBe(false);
  });

  it.each(["edited", "deleted", "revoked", "legacy", "different_audience"] as const)("excludes a claim whose evidence is %s", async (scenario) => {
    const { engine, context, fixture } = await setup();
    await engine.ingest(fixtureMemoryIngest({ ...base, ...(scenario === "legacy" ? {} : { context }) }));
    if (scenario === "edited") fixture.sources.get("original")!.event.content = "I dislike apples";
    if (scenario === "deleted") fixture.sources.delete("original");
    if (scenario === "revoked") fixture.denied.add("original");
    if (scenario === "different_audience") { fixture.port.channelId = "other"; fixture.sources.get("current")!.event.channelId = "other"; }
    const lease = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 12000, burstIds: [] });
    const recalled = await engine.recall({ guildId: "guild", channelId: fixture.port.channelId, userId: "alice", message: "apples", recentHistory: [], subjectIds: ["alice"], now: 4000, context: lease });
    expect(recalled.memories).toEqual([]);
  });

  it("does not disclose private memory into a public channel even to its owner", async () => {
    const { engine, context, fixture } = await setup(false);
    const row = (await engine.ingest(fixtureMemoryIngest({ ...base, context }))).ingested[0]!;
    const publicLease = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 12000, burstIds: [] });
    expect(await publicLease.memories([row])).toEqual([]);
    fixture.port.audienceUserId = "alice";
    const privateLease = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 12000, burstIds: [] });
    expect(await privateLease.memories([row])).toHaveLength(1);
  });

  it("prefetches claim dependencies in one batch before verifying them", async () => {
    const { engine, context, fixture } = await setup(false);
    const row = (await engine.ingest(fixtureMemoryIngest({ ...base, context }))).ingested[0]!;
    fixture.port.audienceUserId = "alice";
    const prepare = vi.fn((_ids: readonly string[]) => Promise.resolve()); fixture.port.prepareValidation = prepare;
    const lease = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 12000, burstIds: [] }); prepare.mockClear();
    expect(await lease.memories([row, { ...row, id: "copy" }])).toHaveLength(2);
    expect(prepare).toHaveBeenCalledWith(["original"], expect.anything());
  });

  it("never writes a claim from a revoked background snapshot", async () => {
    const { engine, context, deny } = await setup(); deny();
    await expect(engine.ingest(fixtureMemoryIngest({ ...base, context }))).rejects.toThrow();
    expect(await engine.listUserMemories("guild", "alice")).toEqual([]);
  });

  it("does not let an unproven overwrite inherit another statement's proof", async () => {
    const { engine, context } = await setup();
    await engine.ingest(fixtureMemoryIngest({ ...base, context }));
    const proposal = base.proposals[0]!; if (proposal.action !== "upsert") throw new Error("Expected upsert");
    const revised = await engine.ingest(fixtureMemoryIngest({ ...base, now: 2500, proposals: [{ ...proposal, statement: "likes red pears" }] }));
    expect(revised.ingested[0]?.contextProvenance).toBeUndefined();
  });
});
