import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashContent } from "../../src/application/assets/content-hash.js";
import type { ContextProvenance } from "../../src/application/chat/context-provenance.js";
import type { MessageOriginRecord } from "../../src/application/chat/message-origin-store.js";
import { ProvenanceBackfill } from "../../src/application/provenance/provenance-backfill.js";
import { ProvenanceShadowWriter } from "../../src/application/provenance/provenance-shadow.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMessageOriginStore } from "../../src/infrastructure/persistence/sqlite-message-origin-store.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

const dependency = (messageId: string): ContextProvenance["dependencies"][number] =>
  ({ guildId: "guild", channelId: "channel", messageId, authorId: messageId.startsWith("r") ? "bot" : "alice", timestampMs: 1_000, representationHash: hashContent(messageId) });
const legacy = (messageId: string, sources: readonly string[], createdAt: number): MessageOriginRecord => ({
  guildId: "guild", channelId: "channel", messageId, origin: "chat", sourceMessageId: "q", createdAt,
  contextProvenance: { version: 1, coverage: "complete", audience: { guildId: "guild", channelId: "channel", userId: null }, outputHash: hashContent(messageId),
    dependencies: sources.map(dependency), unresolved: [] },
});

async function setup(records: readonly MessageOriginRecord[]): Promise<{ graph: SqliteProvenanceGraphStore; origins: SqliteMessageOriginStore; revocations: SqliteMessageRevocationStore;
  counts: () => { revisions: number; edges: number; pointers: number } }> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-backfill-"))); close.push(() => connection.close());
  const origins = new SqliteMessageOriginStore(connection.database);
  for (const record of records) await origins.record(record);
  const count = (table: string): number => connection.database.get<{ count: number }>(sql.raw(`SELECT count(*) AS count FROM ${table}`)).count;
  return { graph: new SqliteProvenanceGraphStore(connection.database), origins, revocations: new SqliteMessageRevocationStore(connection.database),
    counts: () => ({ revisions: count("provenance_revisions"), edges: count("provenance_edges"), pointers: count("provenance_current") }) };
}

describe("ProvenanceBackfill", () => {
  it("imports each dependency as a direct, flattened edge and infers no chain", async () => {
    const { graph, origins } = await setup([legacy("r1", ["m"], 1_000), legacy("r2", ["q", "r1", "m"], 2_000)]);
    expect(await new ProvenanceBackfill(graph, origins).runBatch(null)).toEqual({ imported: 2, skipped: 0, next: null });
    const r2 = (await graph.current("guild", "channel", "reply_part", "r2"))!.revisionId;
    const messages = await graph.currentMany("guild", "channel", "message", ["q", "r1", "m"]);
    // r1 is in the graph now, yet r2 still points at its message, not at r1's revision.
    expect((await graph.parents(r2)).map((parent) => parent.revisionId).sort()).toEqual([...messages.values()].sort());
  });

  it("can be interrupted and rerun without duplicates", async () => {
    const { graph, origins, counts } = await setup([legacy("r1", ["a", "b"], 1_000), legacy("r2", ["b", "c"], 2_000), legacy("r3", ["c"], 3_000)]);
    const backfill = new ProvenanceBackfill(graph, origins);
    const first = await backfill.runBatch(null, 2);
    expect(first).toMatchObject({ imported: 2, next: { messageId: "r2" } });
    vi.spyOn(graph, "publish").mockRejectedValueOnce(new Error("process stopped"));
    await expect(backfill.runBatch(first.next, 2)).rejects.toThrow("process stopped");
    vi.restoreAllMocks();
    // A rerun from the start skips what is already imported and finishes the rest.
    expect(await backfill.runBatch(null, 10)).toEqual({ imported: 1, skipped: 2, next: null });
    expect(await backfill.runBatch(null, 10)).toEqual({ imported: 0, skipped: 3, next: null });
    expect(counts()).toEqual({ revisions: 6, edges: 5, pointers: 6 });
  });

  it("lets a newer dual-written revision win", async () => {
    const { graph, origins } = await setup([legacy("r1", ["m"], 1_000)]);
    const writer = new ProvenanceShadowWriter(graph);
    // The live turn records r1 while the backfill is between its checks and its publication.
    const ensure = graph.ensureMessages.bind(graph);
    vi.spyOn(graph, "ensureMessages").mockImplementationOnce(async (...args) => {
      const found = await ensure(...args);
      await writer.recordReplyPart(legacy("r1", ["m"], 1_000), [{ messageId: "m", origin: "human", direct: true, carriers: [] }]);
      return found;
    });
    const live = await new ProvenanceBackfill(graph, origins).runBatch(null);
    expect(live).toMatchObject({ imported: 0, skipped: 1 });
    const current = (await graph.current("guild", "channel", "reply_part", "r1"))!;
    expect(current.version).toBe(1);
  });

  it("never revives an artifact forgotten before or right after publication", async () => {
    const { graph, origins } = await setup([legacy("r1", ["m"], 1_000), legacy("r2", ["n"], 2_000)]);
    const find = origins.find.bind(origins); let calls = 0;
    // r1 is forgotten before its publication; r2 right after it.
    vi.spyOn(origins, "find").mockImplementation(async (guildId, channelId, messageId) => {
      const found = await find(guildId, channelId, messageId); calls++;
      if (messageId === "r1" || messageId === "r2" && calls >= 3) return found ? { ...found, contextProvenance: null } : null;
      return found;
    });
    expect(await new ProvenanceBackfill(graph, origins).runBatch(null)).toEqual({ imported: 0, skipped: 2, next: null });
    expect(await graph.currentMany("guild", "channel", "reply_part", ["r1", "r2"])).toEqual(new Map());
  });

  it("skips a reply whose dependency was revoked", async () => {
    const { graph, origins, revocations } = await setup([legacy("r1", ["m", "gone"], 1_000)]);
    await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["gone"], revokedAt: 500 });
    expect(await new ProvenanceBackfill(graph, origins).runBatch(null)).toMatchObject({ imported: 0, skipped: 1 });
    expect(await graph.current("guild", "channel", "reply_part", "r1")).toBeNull();
  });
});
