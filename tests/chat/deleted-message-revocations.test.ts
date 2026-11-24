import { fixtureMemoryIngest } from "../helpers/approved-memory-fixture.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteMessageOriginStore } from "../../src/infrastructure/persistence/sqlite-message-origin-store.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { GuardedBackgroundContext } from "../../src/application/context/guarded-background-context.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { DeletedMessageRevocations, type RevocationCleanupStep } from "../../src/application/chat/deleted-message-revocations.js";
import type { MessageRevocationStore } from "../../src/application/chat/message-revocation-store.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import type { MemoryIngestInput } from "../../src/application/memory/memory.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });
const proposal = (statement: string, slot: string): MemoryIngestInput["proposals"][number] => ({ action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
  subjectType: "member", subjectId: "alice", topic: "preference", slot, statement, channelScoped: true });
const base = (now: number, statement: string, slot: string): MemoryIngestInput => ({ guildId: "guild", channelId: "channel", channelMode: "shared", source: "consolidation",
  sourceMessageId: "batch", assertedByUserId: "alice", sourceTimestampMs: 1000, now, proposals: [proposal(statement, slot)] });
const logger = (): Logger & { error: ReturnType<typeof vi.fn> } => {
  const value = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger & { error: ReturnType<typeof vi.fn> };
  (value as unknown as { child: () => Logger }).child = (): Logger => value; return value;
};

interface Stores { repository: SqliteMemoryRepository; origins: SqliteMessageOriginStore; revocations: SqliteMessageRevocationStore; engine: DefaultMemoryEngine; close: () => void }
function open(directory: string): Stores {
  const connection = createSqliteDatabaseConnection(directory); let closed = false;
  const done = (): void => { if (!closed) { closed = true; connection.close(); } }; close.push(done);
  const repository = new SqliteMemoryRepository(connection.database);
  return { repository, origins: new SqliteMessageOriginStore(connection.database), revocations: new SqliteMessageRevocationStore(connection.database),
    engine: new DefaultMemoryEngine(repository, null, null, undefined, null, null, null, () => true), close: done };
}
// A conversation claim citing "chat-source", a daily-summary claim citing "summary-source", a stored bot
// reply whose proof cites "chat-source", and a bot reply "bot-reply" that is itself deleted.
async function seed(stores: Stores): Promise<void> {
  const fixture = guardedFixture(guardedEvent("chat-source", 2000, "I like green apples"));
  const lease = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 12000, burstIds: [] });
  await stores.engine.ingest(fixtureMemoryIngest({ ...base(2500, "likes green apples", "food.fruit"), context: lease }));
  const summary = await GuardedBackgroundContext.open("summary", [{ id: "summary-source", guildId: "guild", channelId: "channel", authorId: "alice",
    authorDisplayName: "alice", content: "I play the violin", createdAt: 1000 }], { readBatch: vi.fn(), validateBatch: () => Promise.resolve(true) }, () => true);
  await stores.engine.ingest(fixtureMemoryIngest({ ...base(2600, "plays the violin", "hobby.music"), context: summary }));
  await stores.origins.record({ guildId: "guild", channelId: "channel", messageId: "derived-reply", origin: "chat", sourceMessageId: "chat-source", createdAt: 3000,
    contextProvenance: lease.provenance("an answer") });
  await stores.origins.record({ guildId: "guild", channelId: "channel", messageId: "bot-reply", origin: "chat", sourceMessageId: "chat-source", createdAt: 3100,
    contextProvenance: lease.provenance("another answer") });
}
const statements = async (stores: Stores): Promise<string[]> => (await stores.engine.listUserMemories("guild", "alice", "channel")).map((memory) => memory.statement).sort();
const steps = (stores: Stores): RevocationCleanupStep[] => [
  { name: "memory", run: (guildId, channelId, messageIds) => stores.repository.forgetCitingMessages({ guildId, channelId, messageIds }) },
  { name: "origins", run: (guildId, channelId, messageIds) => stores.origins.forgetCitingMessages({ guildId, channelId, messageIds }) },
];
const settings = { honoured: true };
function service(stores: Stores, clock: { now: number }, overrides: Partial<ConstructorParameters<typeof DeletedMessageRevocations>[0]> = {}): DeletedMessageRevocations {
  return new DeletedMessageRevocations({ store: stores.revocations, honoured: () => settings.honoured, steps: steps(stores), logger: logger(),
    now: () => clock.now, leaseMs: 60_000, settleMs: 900_000, retryBaseMs: 30_000, retryMaxMs: 3_600_000, intakeRetryDelaysMs: [0, 0], ...overrides });
}
const work = async (stores: Stores, ids: readonly string[]): Promise<(string | undefined)[]> =>
  (await stores.revocations.cleanupWork(ids.map((messageId) => ({ guildId: "guild", channelId: "channel", messageId })))).map((row) => row?.state);

describe("deleted message revocations", () => {
  afterEach(() => { settings.honoured = true; });

  it("commits the revocation at intake, survives a crash before cleanup, and cleans up after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "revocation-intake-")); const clock = { now: 10_000 };
    const first = open(directory); await seed(first);
    expect(await service(first, clock).intake("guild", "channel", ["chat-source", "bot-reply"])).toBe(true);
    // The worker has not run: rows are still there, but the revocation is already committed.
    expect(await statements(first)).toEqual(["likes green apples", "plays the violin"]);
    expect(await first.revocations.revoked([{ guildId: "guild", channelId: "channel", messageId: "chat-source" }])).toEqual([true]);
    first.close();

    // Restart: fresh connection and readers, and the cleanup work is still queued.
    const second = open(directory);
    expect(await second.revocations.revoked([{ guildId: "guild", channelId: "channel", messageId: "chat-source" }, { guildId: "guild", channelId: "channel", messageId: "bot-reply" }])).toEqual([true, true]);
    expect(await work(second, ["chat-source", "bot-reply"])).toEqual(["pending", "pending"]);
    const worker = service(second, clock);
    expect(await worker.runOnce()).toBe(2);
    // Conversation-derived memory is gone; what the daily summary built is kept.
    expect(await statements(second)).toEqual(["plays the violin"]);
    expect((await second.origins.find("guild", "channel", "derived-reply"))?.contextProvenance ?? null).toBeNull();
    expect(await second.origins.find("guild", "channel", "bot-reply")).toBeNull();
    expect(await work(second, ["chat-source", "bot-reply"])).toEqual(["settling", "settling"]);
    // A turn already in flight writes after the first pass; the settle pass removes it.
    await seed(second);
    expect(await worker.runOnce()).toBe(0);
    clock.now += 900_000;
    expect(await worker.runOnce()).toBe(2);
    expect(await statements(second)).toEqual(["plays the violin"]);
    expect(await work(second, ["chat-source", "bot-reply"])).toEqual(["done", "done"]);
  });

  it("records nothing when the guild turned the setting off at intake", async () => {
    const stores = open(mkdtempSync(join(tmpdir(), "revocation-off-"))); await seed(stores); const clock = { now: 10_000 };
    settings.honoured = false;
    expect(await service(stores, clock).intake("guild", "channel", ["chat-source"])).toBe(true);
    expect(await stores.revocations.revoked([{ guildId: "guild", channelId: "channel", messageId: "chat-source" }])).toEqual([false]);
    expect(await service(stores, clock).runOnce()).toBe(0);
    expect(await statements(stores)).toEqual(["likes green apples", "plays the violin"]);
  });

  it("keeps a committed revocation and finishes its cleanup after the setting is turned off", async () => {
    const stores = open(mkdtempSync(join(tmpdir(), "revocation-flip-"))); await seed(stores); const clock = { now: 10_000 };
    await service(stores, clock).intake("guild", "channel", ["chat-source"]);
    settings.honoured = false;
    expect(await service(stores, clock).runOnce()).toBe(1);
    expect(await statements(stores)).toEqual(["plays the violin"]);
    expect(await stores.revocations.revoked([{ guildId: "guild", channelId: "channel", messageId: "chat-source" }])).toEqual([true]);
  });

  it("converges on one cleanup for duplicate delete events and repeated workers", async () => {
    const stores = open(mkdtempSync(join(tmpdir(), "revocation-dup-"))); const clock = { now: 10_000 };
    const run = vi.fn((_guildId: string, _channelId: string, _ids: readonly string[]) => Promise.resolve(0));
    const worker = service(stores, clock, { steps: [{ name: "count", run }] });
    // A single delete and the bulk delete that also covers it, then the same event again.
    await worker.intake("guild", "channel", ["m1"]);
    await worker.intake("guild", "channel", ["m1", "m2"]);
    await worker.intake("guild", "channel", ["m1", "m2"]);
    expect(await stores.revocations.revision("guild", "channel")).toBe(2);
    await Promise.all([worker.runOnce(), service(stores, clock, { steps: [{ name: "count", run }] }).runOnce()]);
    expect(run.mock.calls.flatMap((call) => call[2]).sort()).toEqual(["m1", "m2"]);
  });

  it("retries a failed cleanup step with backoff and keeps the revocation enforced meanwhile", async () => {
    const stores = open(mkdtempSync(join(tmpdir(), "revocation-retry-"))); const clock = { now: 10_000 };
    let failures = 1; const run = vi.fn(() => failures-- > 0 ? Promise.reject(new Error("database busy")) : Promise.resolve(1));
    const log = logger(); const worker = service(stores, clock, { steps: [{ name: "flaky", run }], logger: log });
    await worker.intake("guild", "channel", ["m1"]);
    expect(await worker.runOnce()).toBe(0);
    expect(log.error).toHaveBeenCalled();
    expect((await stores.revocations.cleanupWork([{ guildId: "guild", channelId: "channel", messageId: "m1" }]))[0]).toMatchObject({ state: "pending", attempts: 1, nextAt: 40_000 });
    expect(await stores.revocations.revoked([{ guildId: "guild", channelId: "channel", messageId: "m1" }])).toEqual([true]);
    clock.now = 39_999; expect(await worker.runOnce()).toBe(0);
    clock.now = 40_000; expect(await worker.runOnce()).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retries intake and reports a failure to record the delete", async () => {
    const stores = open(mkdtempSync(join(tmpdir(), "revocation-fail-"))); const clock = { now: 10_000 };
    const revoke = vi.fn().mockRejectedValueOnce(new Error("locked")).mockImplementation((input: Parameters<MessageRevocationStore["revoke"]>[0]) => stores.revocations.revoke(input));
    const flaky = { ...stores.revocations, revoke, revoked: stores.revocations.revoked.bind(stores.revocations) } as unknown as MessageRevocationStore;
    expect(await service(stores, clock, { store: flaky }).intake("guild", "channel", ["m1"])).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(2);
    const log = logger(); const failing = vi.fn(() => Promise.reject(new Error("down")));
    const down = { revoke: failing } as unknown as MessageRevocationStore;
    expect(await service(stores, clock, { store: down, logger: log }).intake("guild", "channel", ["m2"])).toBe(false);
    expect(failing).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ guildId: "guild", channelId: "channel", messages: 1 }), expect.stringContaining("record"));
  });
});
