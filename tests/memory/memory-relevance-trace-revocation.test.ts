import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryRelevanceTraceInput } from "../../src/application/memory/memory-relevance-trace.js";
import { FileMemoryRelevanceTraceCollector } from "../../src/infrastructure/persistence/file-memory-relevance-trace-collector.js";
import type { MessageRevocationKey } from "../../src/application/chat/message-revocation-store.js";

const input = (message: string, sourceIds: readonly string[], guildId = "guild"): MemoryRelevanceTraceInput => ({
  guildId, channelId: "general", message, recentHistory: ["earlier"], subjectIds: ["alice"], now: 1_000,
  candidates: [{ id: "a", subjectId: "alice", topic: "t", slot: "s1", statement: `${message} candidate one`, updatedAt: 1 },
    { id: "b", subjectId: "alice", topic: "t", slot: "s2", statement: `${message} candidate two`, updatedAt: 2 }],
  selectedIds: ["a"], maxSerializedChars: 8_000, requireTopicalMatch: false, sources: sourceIds.map((messageId) => ({ channelId: "general", messageId })) });

function revocations(): { revoked: Set<string>; latest: Map<string, number>; port: { revoked: (keys: readonly MessageRevocationKey[]) => Promise<readonly boolean[]>; latestRevocationAt: (guildId: string) => Promise<number | null> } } {
  const revoked = new Set<string>(); const latest = new Map<string, number>();
  return { revoked, latest, port: {
    revoked: (keys) => Promise.resolve(keys.map((key) => revoked.has(`${key.guildId}/${key.channelId}/${key.messageId}`))),
    latestRevocationAt: (guildId) => Promise.resolve(latest.get(guildId) ?? null),
  } };
}

// A5 trace policy: samples record their sources, a sample without complete lineage is not kept,
// revoked samples are hidden from review and export at once and compacted away by cleanup.
describe("relevance trace revocations", () => {
  it("does not sample a trace without lineage, or one whose sources are already revoked", async () => {
    const directory = mkdtempSync(join(tmpdir(), "trace-lineage-")); const { revoked, port } = revocations();
    const collector = new FileMemoryRelevanceTraceCollector(directory, 1); collector.bindRevocations(port);
    const { sources: _omitted, ...withoutLineage } = input("no lineage", ["m1"]);
    await collector.record(withoutLineage);
    revoked.add("guild/general/m2");
    await collector.record(input("revoked source", ["m2"]));
    expect(await collector.latestPending("guild")).toBeNull();
  });

  it("hides a revoked sample from review, labelling and export before cleanup, then compacts it away", async () => {
    const directory = mkdtempSync(join(tmpdir(), "trace-revoked-")); const { revoked, latest, port } = revocations();
    const collector = new FileMemoryRelevanceTraceCollector(directory, 1); collector.bindRevocations(port);
    await collector.record(input("kept sample", ["m-kept"]));
    await collector.record(input("SECRET sample", ["m-deleted"]));
    const secret = (await collector.latestPending("guild"))!;
    await collector.label({ guildId: "guild", traceId: secret.id, relevantCandidateIds: ["a"], split: "calibration" });
    const kept = (await collector.latestPending("guild"))!;
    expect(kept.message).toBe("kept sample");
    expect((await collector.exportCases("guild")).map((entry) => entry.message)).toEqual(["SECRET sample"]);

    revoked.add("guild/general/m-deleted"); latest.set("guild", 5_000);
    expect((await collector.exportCases("guild")).map((entry) => entry.message)).toEqual([]);
    await expect(collector.skip("guild", secret.id)).rejects.toThrow("not found");
    // The unaffected sample is still reviewable.
    expect((await collector.latestPending("guild"))?.id).toBe(kept.id);

    expect(await collector.forgetCitingMessages("guild", "general", ["m-deleted"])).toBe(1);
    const file = readFileSync(join(directory, "memory-relevance", "traces.jsonl"), "utf8");
    expect(file).not.toContain("SECRET");
    expect(file).not.toContain(secret.id);
    // A fresh collector over the compacted file still reviews and exports the unaffected sample.
    const reopened = new FileMemoryRelevanceTraceCollector(directory, 1); reopened.bindRevocations(port);
    await reopened.label({ guildId: "guild", traceId: kept.id, relevantCandidateIds: ["b"], split: "validation" });
    expect((await reopened.exportCases("guild")).map((entry) => entry.message)).toEqual(["kept sample"]);
  });

  it("withholds and then purges legacy samples without lineage at guild scope, leaving other guilds working", async () => {
    const directory = mkdtempSync(join(tmpdir(), "trace-legacy-")); const { latest, port } = revocations();
    mkdirSync(join(directory, "memory-relevance"), { recursive: true });
    const legacy = (id: string, guildId: string, recordedAt: number): string => JSON.stringify({ type: "trace", id, recordedAt, guildId, channelId: "general",
      message: `legacy ${guildId}`, recentHistory: [], subjectIds: [], now: 1, selectedIds: [], maxSerializedChars: 100, requireTopicalMatch: false,
      candidates: [{ id: "a", subjectId: "s", topic: "t", slot: "x", statement: "one", updatedAt: 1 }, { id: "b", subjectId: "s", topic: "t", slot: "y", statement: "two", updatedAt: 1 }] });
    writeFileSync(join(directory, "memory-relevance", "traces.jsonl"), [legacy("legacy-1", "guild", 1_000), legacy("legacy-2", "other", 1_000)].join("\n") + "\n");
    const collector = new FileMemoryRelevanceTraceCollector(directory, 1); collector.bindRevocations(port);
    expect((await collector.latestPending("guild"))?.id).toBe("legacy-1");
    latest.set("guild", 2_000);
    expect(await collector.latestPending("guild")).toBeNull();
    expect((await collector.latestPending("other"))?.id).toBe("legacy-2");
    expect(await collector.forgetCitingMessages("guild", "general", ["anything"])).toBe(1);
    const file = readFileSync(join(directory, "memory-relevance", "traces.jsonl"), "utf8");
    expect(file).not.toContain("legacy-1");
    expect(file).toContain("legacy-2");
  });

  it("does not lose a sample recorded while compaction runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "trace-race-")); const { revoked, port } = revocations();
    const collector = new FileMemoryRelevanceTraceCollector(directory, 1); collector.bindRevocations(port);
    await collector.record(input("doomed", ["m-deleted"]));
    revoked.add("guild/general/m-deleted");
    await Promise.all([collector.forgetCitingMessages("guild", "general", ["m-deleted"]), collector.record(input("new sample", ["m-new"]))]);
    const file = readFileSync(join(directory, "memory-relevance", "traces.jsonl"), "utf8");
    expect(file).toContain("new sample");
    expect(file).not.toContain("doomed");
  });

  it("fails closed when the revocation check errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "trace-failing-"));
    const collector = new FileMemoryRelevanceTraceCollector(directory, 1);
    await collector.record(input("sample", ["m1"]));
    collector.bindRevocations({ revoked: () => Promise.reject(new Error("down")), latestRevocationAt: () => Promise.reject(new Error("down")) });
    expect(await collector.latestPending("guild")).toBeNull();
    expect(await collector.exportCases("guild")).toEqual([]);
  });
});
