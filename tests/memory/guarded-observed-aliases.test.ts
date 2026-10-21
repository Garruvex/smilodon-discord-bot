import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { explicitSelfAlias } from "../../src/application/memory/memory-alias-provenance.js";
import { observedSubjectNames } from "../../src/application/memory/observed-subject-names.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
async function setup(shared = true, proven = true, label = "OldBob"): Promise<{
  engine: DefaultMemoryEngine; fixture: ReturnType<typeof guardedFixture>; row: Awaited<ReturnType<DefaultMemoryEngine["ingest"]>>["ingested"][number];
}> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-aliases-"))); cleanup.push(() => connection.close());
  const engine = new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database), null, null, undefined, null, null, null, () => shared);
  const fixture = guardedFixture(guardedEvent("current", 1000, "Call me OldBob. I like apples.", "bob"));
  fixture.actors.set("bob", { id: "bob", displayName: "NewBob", roleNames: [] });
  const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 4000, burstIds: [] });
  const row = (await engine.ingest({ guildId: "guild", channelId: "channel", channelMode: "shared", assertedByUserId: "bob", sourceMessageId: "current", source: "live", now: 1000,
    ...(proven ? { context } : {}), proposals: [{ action: "upsert", audience: "private", kind: "preference", ownerUserId: "bob", subjectType: "member", subjectId: "bob",
      topic: "preference", slot: "food.fruit", statement: "likes apples", channelScoped: true, observedSubjectNames: [label, "apples", "Unbacked"] }] })).ingested[0]!;
  fixture.add(guardedEvent("query", 2000, `${label} likes what?`)); fixture.port.sourceMessageId = "query"; fixture.port.actorId = "alice";
  return { engine, fixture, row };
}
async function recall(engine: DefaultMemoryEngine, fixture: ReturnType<typeof guardedFixture>, label = "OldBob"): ReturnType<DefaultMemoryEngine["recall"]> {
  const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 4000, burstIds: [] });
  return engine.recall({ guildId: "guild", channelId: "channel", userId: fixture.port.actorId ?? "alice", channelMode: "shared", message: `${label} likes what?`, recentHistory: [], subjectIds: [], now: 2000, context });
}

describe("authorized observed aliases", () => {
  it("mints separate evidence for literal introductions and current names, excluding invented labels", async () => {
    const { engine, fixture, row } = await setup();
    expect(observedSubjectNames(row).map((name) => name.value).sort()).toEqual(["NewBob", "OldBob"]);
    expect(observedSubjectNames(row).every((name) => name.contextProvenance)).toBe(true);
    const result = await recall(engine, fixture);
    expect(result.aliasCandidates).toEqual([{ alias: "oldbob", subjectIds: ["bob"] }]);
    expect(result.aliasSources?.[0]).toMatchObject({ statement: "", contextProvenance: null, embedding: null });
  });
  it("keeps a verified introduction across profile renames without trusting stale profile labels", async () => {
    const { engine, fixture } = await setup();
    fixture.actors.get("bob")!.displayName = "NewestBob";
    fixture.sources.get("current")!.event.author!.displayName = "NewestBob";
    expect((await recall(engine, fixture)).aliasCandidates).toEqual([{ alias: "oldbob", subjectIds: ["bob"] }]);
    expect((await recall(engine, fixture, "NewBob")).aliasCandidates ?? []).toEqual([]);
  });
  it.each(["edited", "deleted", "denied", "subject_hidden"] as const)("excludes aliases after evidence is %s", async (scenario) => {
    const { engine, fixture } = await setup();
    if (scenario === "edited") fixture.sources.get("current")!.event.content = "I like pears";
    if (scenario === "deleted") fixture.sources.delete("current");
    if (scenario === "denied") fixture.denied.add("current");
    if (scenario === "subject_hidden") fixture.actors.delete("bob");
    expect((await recall(engine, fixture)).aliasCandidates ?? []).toEqual([]);
  });
  it("does not turn legacy labels into evidence, but can independently resolve a current authorized profile", async () => {
    const { engine, fixture } = await setup(true, false);
    expect((await recall(engine, fixture)).aliasCandidates ?? []).toEqual([]);
    const current = await setup(true, false, "NewBob");
    const result = await recall(current.engine, current.fixture, "NewBob");
    expect(result.aliasCandidates).toEqual([{ alias: "newbob", subjectIds: ["bob"] }]);
    expect(result.memories).toEqual([]);
  });
  it("requires a private destination even when the requester owns the private alias", async () => {
    const { engine, fixture } = await setup(false); fixture.port.actorId = "bob";
    fixture.add(guardedEvent("query", 2000, "OldBob likes what?", "bob"));
    expect((await recall(engine, fixture)).aliasCandidates ?? []).toEqual([]);
    fixture.port.audienceUserId = "bob";
    expect((await recall(engine, fixture)).aliasCandidates).toEqual([{ alias: "oldbob", subjectIds: ["bob"] }]);
  });
  it("preserves collisions and marks a bounded lookup incomplete instead of guessing one person", async () => {
    const { fixture, row } = await setup();
    fixture.actors.set("carol", { id: "carol", displayName: "Carol", roleNames: [] });
    fixture.add(guardedEvent("carol-source", 1500, "Call me OldBob", "carol"));
    const context = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 4000, burstIds: [] });
    const other = { ...row, id: "other", subjectId: "carol" };
    other.structuredValue = { observedSubjectNames: await context.observeAliases(other, ["OldBob"], 2000) };
    const collision = await context.aliases([row, other], "OldBob", 2000);
    expect(collision.rows.map((alias) => alias.subjectId).sort()).toEqual(["bob", "carol"]);
    expect(collision.incomplete).toBe(false);
    const bounded = await context.aliases(Array.from({ length: 129 }, () => row), "OldBob", 2000);
    expect(bounded.incomplete).toBe(true);
    expect((await context.aliases([row], "OldBob", 2000)).incomplete).toBe(true);
  });
  it.each([
    ["Call me A.*B.", "A.*B", true], ["Call me AnotherB.", "A.*B", false],
    ["Don't call me OldBob", "OldBob", false], ["不要叫我老王", "老王", false],
    ["叫我老王。", "老王", true], ["My nickname is Old Bob.", "Old Bob", true],
  ])("recognizes only a literal introduction: %s", (text, name, expected) => {
    expect(explicitSelfAlias(text, name)).toBe(expected);
  });
});
