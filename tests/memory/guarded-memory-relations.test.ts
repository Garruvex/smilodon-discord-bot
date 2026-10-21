import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { memoryRelations } from "../../src/infrastructure/database/sqlite-schema.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import type { ProposedRelation } from "../../src/application/memory/memory.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const edges: ProposedRelation[] = [
  { fromSubjectType: "member", fromSubjectId: "alice", predicate: "owes", kind: "consequence", toSubjectType: "member", toSubjectId: "bob" },
  { fromSubjectType: "member", fromSubjectId: "bob", predicate: "owes", kind: "consequence", toSubjectType: "member", toSubjectId: "carol" },
];

describe("guarded relational evidence", () => {
  it.each(["verified", "hidden_intermediate", "source_edited", "edge_tampered", "unproven"] as const)("authorizes every edge and endpoint before traversing a path: %s", async (scenario) => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-relations-"))); cleanup.push(() => connection.close());
    const repository = new SqliteMemoryRepository(connection.database); const engine = new DefaultMemoryEngine(repository);
    const fixture = guardedFixture(guardedEvent("current", 4000, "Alice owes Bob, and Bob owes Carol"));
    for (const id of ["bob", "carol"]) fixture.actors.set(id, { id, displayName: id, roleNames: [] });
    const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 4000, burstIds: [] });
    if (scenario === "unproven") await repository.createRelations(edges.map((edge) => ({ ...edge, guildId: "guild", channelId: "channel", isolationChannelId: null, supportingMemoryId: null, now: 4000 })));
    else expect((await engine.ingestRelations({ guildId: "guild", channelId: "channel", channelMode: "shared", proposals: edges, context, supportingMemoryId: null, now: 4000 })).created).toBe(2);
    if (scenario === "hidden_intermediate") fixture.actors.delete("bob");
    if (scenario === "source_edited") fixture.sources.get("current")!.event.content = "different topic";
    if (scenario === "edge_tampered") connection.database.update(memoryRelations).set({ toSubjectId: "carol" }).where(eq(memoryRelations.fromSubjectId, "alice")).run();
    const fresh = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 4000, burstIds: [] });
    const related = await repository.findRelatedSubjects({ guildId: "guild", channelId: "channel", subjectIds: ["alice"], maxHops: 2, context: fresh, now: 5000 });
    expect(related.map((subject) => subject.subjectId)).toEqual(scenario === "verified" ? ["bob", "carol"] : []);
    if (scenario === "verified") {
      const recalled = await engine.recall({ guildId: "guild", channelId: "channel", userId: "alice", channelMode: "shared", message: "debts", recentHistory: [], subjectIds: ["alice"], now: 5000, context: fresh });
      expect(recalled.causalChains.map((chain) => chain.toSubjectId)).toEqual(["bob", "carol"]);
      expect(recalled.causalChains.every((chain) => chain.sourceRelation?.contextProvenance?.purpose === "relation")).toBe(true);
      expect(await repository.findRelatedSubjects({ guildId: "guild", channelId: "other", subjectIds: ["alice"], maxHops: 2 })).toEqual([]);
    }
  });

  it("refreshes a matching scoped edge only from newly authorized evidence", async () => {
    const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-relation-refresh-"))); cleanup.push(() => connection.close());
    const repository = new SqliteMemoryRepository(connection.database); const engine = new DefaultMemoryEngine(repository);
    await repository.createRelations([{ ...edges[0]!, guildId: "guild", channelId: "channel", isolationChannelId: null, supportingMemoryId: null, now: 1000 }]);
    const fixture = guardedFixture(); fixture.actors.set("bob", { id: "bob", displayName: "bob", roleNames: [] });
    const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 4000, burstIds: [] });
    expect(await repository.findRelatedSubjects({ guildId: "guild", channelId: "channel", subjectIds: ["alice"], maxHops: 1, context })).toEqual([]);
    expect((await engine.ingestRelations({ guildId: "guild", channelId: "channel", channelMode: "shared", proposals: [edges[0]!], context, supportingMemoryId: null, now: 4000 })).created).toBe(0);
    expect((await repository.findRelatedSubjects({ guildId: "guild", channelId: "channel", subjectIds: ["alice"], maxHops: 1, context })).map((subject) => subject.subjectId)).toEqual(["bob"]);
  });
});
