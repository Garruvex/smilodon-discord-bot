import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProvenanceAdmissionGate, parseProvenanceReaderModes, type ProvenanceComparison, type ProvenanceReaderMode } from "../../src/application/provenance/provenance-admission.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

async function graphWith(): Promise<{ graph: SqliteProvenanceGraphStore; revocations: SqliteMessageRevocationStore }> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-admission-"))); close.push(() => connection.close());
  const graph = new SqliteProvenanceGraphStore(connection.database);
  const messages = await graph.ensureMessages("guild", "channel", [{ messageId: "m", authorId: "alice", timestampMs: 1 }, { messageId: "n", authorId: "bob", timestampMs: 2 }], 1);
  for (const [artifactId, source] of [["graph-only", "m"], ["both", "n"]] as const) {
    await graph.publish({ guildId: "guild", channelId: "channel", kind: "reply_part", artifactId, version: 1, completeness: "complete", outputHash: "a".repeat(64),
      parents: [{ revisionId: messages.get(source)!, projection: "full", representationHash: "b".repeat(64) }], publishedAt: 2 });
  }
  return { graph, revocations: new SqliteMessageRevocationStore(connection.database) };
}

const scope = { guildId: "guild", channelId: "channel", audienceUserId: null };
const candidates = [{ graphKind: "reply_part" as const, artifactId: "graph-only", v1: false }, { graphKind: "reply_part" as const, artifactId: "both", v1: true },
  { graphKind: "reply_part" as const, artifactId: "legacy", v1: true }];

describe("ProvenanceAdmissionGate", () => {
  it("lets the graph decide in v2, and hides a graph-only output again on rollback to v1", async () => {
    const { graph } = await graphWith();
    let mode: ProvenanceReaderMode = "v2";
    const gate = new ProvenanceAdmissionGate(graph, () => mode);
    // The unmigrated legacy item keeps its complete v1 path.
    expect(await gate.decide("reply_part", scope, candidates)).toEqual([true, true, true]);
    mode = "v1";
    expect(await gate.decide("reply_part", scope, candidates)).toEqual([false, true, true]);
  });

  it("keeps v1's decision in shadow mode and counts each disagreement and its reason, without IDs", async () => {
    const { graph, revocations } = await graphWith();
    const reports: ProvenanceComparison[] = [];
    const gate = new ProvenanceAdmissionGate(graph, () => "shadow", (comparison) => reports.push(comparison));
    await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["n"], revokedAt: 5 });
    expect(await gate.decide("reply_part", scope, candidates)).toEqual([false, true, true]);
    expect(reports).toEqual([{ kind: "reply_part", mode: "shadow", candidates: 3, agreed: 0, newlyAdmitted: 1, newlyRejected: 1, unmigrated: 1, reasons: ["revoked"] }]);
    expect(JSON.stringify(reports)).not.toContain("graph-only");
    // The same revocation binds the graph reader once it decides.
    const v2 = new ProvenanceAdmissionGate(graph, () => "v2");
    expect(await v2.decide("reply_part", scope, candidates)).toEqual([true, false, true]);
  });

  it("fails closed in v2 and falls back to v1 in shadow when the graph check fails", async () => {
    const { graph } = await graphWith();
    vi.spyOn(graph, "checkAncestry").mockRejectedValue(new Error("database unavailable"));
    expect(await new ProvenanceAdmissionGate(graph, () => "v2").decide("reply_part", scope, candidates)).toEqual([false, false, false]);
    expect(await new ProvenanceAdmissionGate(graph, () => "shadow").decide("reply_part", scope, candidates)).toEqual([false, true, true]);
  });

  it("reads per-kind modes and leaves anything unnamed or malformed on v1", () => {
    const modes = parseProvenanceReaderModes("reply_part=v2, claim=shadow,alias=sideways,unknown=v2");
    expect([modes("reply_part"), modes("claim"), modes("alias"), modes("relation")]).toEqual(["v2", "shadow", "v1", "v1"]);
    expect(parseProvenanceReaderModes(undefined)("session")).toBe("v1");
  });
});
