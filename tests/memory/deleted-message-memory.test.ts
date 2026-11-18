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
import { DeletedMessageMemory } from "../../src/application/memory/deleted-message-memory.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import type { MemoryIngestInput } from "../../src/application/memory/memory.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });
const proposal = (statement: string, slot: string): MemoryIngestInput["proposals"][number] => ({ action: "upsert", audience: "private", kind: "preference", ownerUserId: "alice",
  subjectType: "member", subjectId: "alice", topic: "preference", slot, statement, channelScoped: true });
const base = (now: number, statement: string, slot: string): MemoryIngestInput => ({ guildId: "guild", channelId: "channel", channelMode: "shared", source: "consolidation",
  sourceMessageId: "batch", assertedByUserId: "alice", sourceTimestampMs: 1000, now, proposals: [proposal(statement, slot)] });

async function setup(): Promise<{ engine: DefaultMemoryEngine; repository: SqliteMemoryRepository }> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "deleted-source-"))); close.push(() => connection.close());
  const repository = new SqliteMemoryRepository(connection.database);
  const engine = new DefaultMemoryEngine(repository, null, null, undefined, null, null, null, () => true);
  // Learned in conversation, citing the message "chat-source".
  const fixture = guardedFixture(guardedEvent("chat-source", 2000, "I like green apples"));
  const lease = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 12000, burstIds: [] });
  await engine.ingest(fixtureMemoryIngest({ ...base(2500, "likes green apples", "food.fruit"), context: lease }));
  // Built by a daily summary, citing the message "summary-source".
  const summary = await GuardedBackgroundContext.open("summary", [{ id: "summary-source", guildId: "guild", channelId: "channel", authorId: "alice",
    authorDisplayName: "alice", content: "I play the violin", createdAt: 1000 }], { readBatch: vi.fn(), validateBatch: () => Promise.resolve(true) }, () => true);
  await engine.ingest(fixtureMemoryIngest({ ...base(2600, "plays the violin", "hobby.music"), context: summary }));
  return { engine, repository };
}
const statements = async (engine: DefaultMemoryEngine): Promise<string[]> => (await engine.listUserMemories("guild", "alice", "channel")).map((memory) => memory.statement).sort();

describe("deleted message memory", () => {
  it("deletes what conversation learned from a deleted message and keeps what a daily summary built", async () => {
    const { engine, repository } = await setup();
    expect(await statements(engine)).toEqual(["likes green apples", "plays the violin"]);
    const memory = new DeletedMessageMemory(repository, () => true);
    expect(await memory.handle("guild", "other-channel", ["chat-source"])).toBe(0);
    expect(await memory.handle("guild", "channel", ["summary-source"])).toBe(0);
    expect(await memory.handle("guild", "channel", ["chat-source", "unrelated"])).toBe(1);
    expect(await statements(engine)).toEqual(["plays the violin"]);
  });

  it("keeps everything when the guild turned the setting off", async () => {
    const { engine, repository } = await setup();
    expect(await new DeletedMessageMemory(repository, () => false).handle("guild", "channel", ["chat-source"])).toBe(0);
    expect(await statements(engine)).toEqual(["likes green apples", "plays the violin"]);
  });
});
