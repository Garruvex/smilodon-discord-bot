import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MemoryRelevanceTraceInput } from "../../src/application/memory/memory-relevance-trace.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { FileMemoryRelevanceTraceCollector } from "../../src/infrastructure/persistence/file-memory-relevance-trace-collector.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { fixtureMemoryIngest } from "../helpers/approved-memory-fixture.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

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
    sources: [{ channelId: "general", messageId: "query" }],
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
  // A trace holds message text, so it is sampled only from a guarded turn whose candidates all carry
  // claim proofs; its lineage is what lets a later delete find and remove it.
  it("records lineage from the guarded turn and the candidates' conversational sources", async () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-relevance-lineage-"));
    const connection = createSqliteDatabaseConnection(directory);
    const record = vi.fn<(input: MemoryRelevanceTraceInput) => Promise<void>>().mockResolvedValue(undefined);
    const engine = new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database), null, null, undefined, null, { record, includePrivate: false }, null, () => true);
    const learned = guardedFixture(guardedEvent("taught", 100, "I like green apples and I work as an engineer"));
    const teach = await GuardedConversationContext.open(learned.port, { count: 0, budget: 12000, burstIds: [] });
    for (const [slot, statement, audience] of [["food.fruit", "likes green apples", "guild"], ["job.role", "works as an engineer", "guild"],
      ["private.note", "private medical detail", "private"]] as const) {
      await engine.ingest(fixtureMemoryIngest({ guildId: "guild", channelId: "channel", channelMode: "shared", assertedByUserId: "alice", sourceMessageId: "taught",
        source: "live", now: 150, context: teach, proposals: [{ action: "upsert", audience, kind: "fact", ownerUserId: audience === "private" ? "alice" : null,
          subjectType: "member", subjectId: "alice", topic: "profile", slot, statement, channelScoped: true }] }));
    }
    const asking = guardedFixture(guardedEvent("question", 200, "what fruit does alice like"));
    asking.add(guardedEvent("taught", 100, "I like green apples and I work as an engineer"));
    asking.port.audienceUserId = "alice";
    const lease = await GuardedConversationContext.open(asking.port, { count: 0, budget: 12000, burstIds: [] });
    const result = await engine.recall({ guildId: "guild", channelId: "channel", userId: "alice", message: "what fruit does alice like", recentHistory: [], subjectIds: ["alice"], now: 300, context: lease });
    expect(record).toHaveBeenCalledOnce();
    const captured = record.mock.calls[0]![0];
    expect(captured.sources).toEqual(expect.arrayContaining([{ channelId: "channel", messageId: "question" }, { channelId: "channel", messageId: "taught" }]));
    // Private memories stay out of samples unless sampling is configured to include them.
    expect(captured.candidates.map((candidate) => candidate.statement).sort()).toEqual(["likes green apples", "works as an engineer"]);
    expect(captured.selectedIds.every((id) => result.memories.some((memory) => memory.id === id))).toBe(true);
  });

  it("samples nothing without a guarded turn, since the lineage would be incomplete", async () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-relevance-engine-"));
    const connection = createSqliteDatabaseConnection(directory);
    const repository = new SqliteMemoryRepository(connection.database);
    const record = vi.fn<(input: MemoryRelevanceTraceInput) => Promise<void>>().mockResolvedValue(undefined);
    const engine = new DefaultMemoryEngine(repository, null, null, undefined, null, { record, includePrivate: false }, null, () => true);
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
    expect(result.memories.length).toBeGreaterThan(0);
    expect(record).not.toHaveBeenCalled();
  });
});
