import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MemoryRelevanceTraceInput } from "../../src/application/memory/memory-relevance-trace.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { FileMemoryRelevanceTraceCollector } from "../../src/infrastructure/persistence/file-memory-relevance-trace-collector.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";

function traceInput(message = "which fruit does alice like"): MemoryRelevanceTraceInput {
  return {
    guildId: "guild",
    channelId: "general",
    message,
    recentHistory: ["we were discussing snacks"],
    subjectIds: ["alice"],
    now: 1_000,
    candidates: [
      {
        id: "candidate-apples", subjectId: "alice", topic: "preference", slot: "food.fruit",
        statement: "likes green apples", updatedAt: 100,
      },
      {
        id: "candidate-role", subjectId: "alice", topic: "identity", slot: "role",
        statement: "works as an engineer", updatedAt: 900,
      },
    ],
    selectedIds: ["candidate-apples"],
    maxSerializedChars: 8_000,
    requireTopicalMatch: false,
  };
}

describe("FileMemoryRelevanceTraceCollector", () => {
  it("records, labels by ID prefix, and exports calibration-compatible cases", async () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-relevance-traces-"));
    const collector = new FileMemoryRelevanceTraceCollector(directory, 1);
    await collector.record(traceInput());

    const pending = await collector.latestPending("guild");
    expect(pending).not.toBeNull();
    await collector.label({
      guildId: "guild",
      traceId: pending!.id.slice(0, 8),
      relevantCandidateIds: ["candidate-a"],
      split: "calibration",
    });

    expect(await collector.latestPending("guild")).toBeNull();
    expect(await collector.exportCases("guild")).toEqual([expect.objectContaining({
      id: pending!.id,
      split: "calibration",
      message: "which fruit does alice like",
      relevantIds: ["candidate-apples"],
      maxSerializedChars: 8_000,
    })]);
  });

  it("keeps skipped and other-guild traces out of an export", async () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-relevance-traces-"));
    const collector = new FileMemoryRelevanceTraceCollector(directory, 1);
    await collector.record(traceInput());
    const pending = await collector.latestPending("guild");
    await collector.skip("guild", pending!.id);

    expect(await collector.exportCases("guild")).toEqual([]);
    expect(await collector.latestPending("other-guild")).toBeNull();
  });
});

describe("DefaultMemoryEngine relevance tracing", () => {
  it("passes the authorized candidates and final selection to the optional collector", async () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-relevance-engine-"));
    const connection = createSqliteDatabaseConnection(directory);
    const repository = new SqliteMemoryRepository(connection.database);
    const record = vi.fn<(input: MemoryRelevanceTraceInput) => Promise<void>>().mockResolvedValue(undefined);
    const engine = new DefaultMemoryEngine(repository, null, null, undefined, null, { record, includePrivate: false });
    for (const [slot, statement, audience] of [
      ["food.fruit", "likes green apples", "guild"],
      ["job.role", "works as an engineer", "guild"],
      ["private.note", "private medical detail", "private"],
    ] as const) {
      await engine.ingest({
        guildId: "guild", channelId: "general", channelMode: "shared",
        assertedByUserId: "alice", sourceMessageId: null, source: "live", now: 100,
        proposals: [{
          action: "upsert", audience, kind: "fact", ownerUserId: audience === "private" ? "alice" : null,
          subjectType: "member", subjectId: "alice", topic: "profile", slot,
          statement, channelScoped: false,
        }],
      });
    }

    const result = await engine.recall({
      guildId: "guild", channelId: "general", channelMode: "shared", userId: "alice",
      message: "what fruit does alice like", recentHistory: [], subjectIds: ["alice"], now: 200,
    });

    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      message: "what fruit does alice like",
      candidates: expect.arrayContaining([
        expect.objectContaining({ statement: "likes green apples" }),
        expect.objectContaining({ statement: "works as an engineer" }),
      ]) as unknown,
    }));
    const captured = record.mock.calls[0]![0];
    expect(captured.candidates).toHaveLength(2);
    expect(captured.candidates.some((candidate) => candidate.statement.includes("medical"))).toBe(false);
    expect(captured.selectedIds.every((id) => result.memories.some((memory) => memory.id === id))).toBe(true);
  });
});
