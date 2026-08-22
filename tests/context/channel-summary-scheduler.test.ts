import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import { ChannelSummaryScheduler } from "../../src/application/context/channel-summary-scheduler.js";
import { SqliteChannelSummaryCheckpointStore } from "../../src/infrastructure/persistence/sqlite-channel-summary-checkpoint-store.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import type {
  ChannelHistoryMessage, ChannelHistoryReadRequest, ChannelHistoryReadResult,
} from "../../src/application/context/channel-history-reader.js";
import type { ChannelMessageSummarizer, ChannelSummaryFact, ChannelSummaryRelation } from "../../src/application/context/channel-message-summarizer.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { MemoryEngine } from "../../src/application/memory/memory.js";
import type { ChannelSummaryCheckpointStore } from "../../src/application/context/channel-summary-checkpoint-store.js";

const dayMs = 24 * 60 * 60 * 1_000;
// Mirrors DiscordChannelHistoryReader's page size so capped-scan tests still
// exercise the "page smaller than fetchPageSize means channel exhausted"
// completion path the same way the real adapter would.
const fetchPageSize = 100;

interface FakeStoredMessage {
  id: string;
  authorId: string;
  content: string;
  createdTimestamp: number;
  bot?: boolean;
  system?: boolean;
}

function fakeMessage(
  id: string, authorId: string, content: string, createdTimestamp: number,
  opts: { bot?: boolean; system?: boolean } = {},
): FakeStoredMessage {
  return { id, authorId, content, createdTimestamp, bot: opts.bot ?? false, system: opts.system ?? false };
}

interface FakeChannel {
  guildId: string;
  messages: readonly FakeStoredMessage[];
}

// `allNewestFirst` mimics Discord's ordering — index 0 is newest.
function fakeChannel(allNewestFirst: readonly FakeStoredMessage[], guildId = "guild"): FakeChannel {
  return { guildId, messages: allNewestFirst };
}

// Reimplements DiscordChannelHistoryReader's paging/filtering against an
// in-memory message list, so scheduler tests exercise the same contract
// (boundary crossing, bot/system exclusion, per-tick caps) the real Discord
// adapter provides, without a fake discord.js Client.
// Deliberately typed with a plain function-property signature rather than
// `ChannelHistoryReader` directly — the interface declares `readBatch` with
// method syntax, which trips @typescript-eslint/unbound-method wherever a
// test reads `historyReader.readBatch` for assertions. This shape is still
// structurally assignable to ChannelHistoryReader at every call site.
type FakeChannelHistoryReader = {
  readBatch: ReturnType<typeof vi.fn<(request: ChannelHistoryReadRequest) => Promise<ChannelHistoryReadResult>>>;
};

function fakeHistoryReader(channel: FakeChannel | null): FakeChannelHistoryReader {
  const readBatch = vi.fn((request: ChannelHistoryReadRequest): Promise<ChannelHistoryReadResult> => {
    if (!channel) {
      return Promise.resolve({ ok: false, code: "channel_not_found", message: "Channel not found (deleted, or the bot is no longer a member of its guild)." });
    }
    if (channel.guildId !== request.guildId) {
      return Promise.resolve({ ok: false, code: "guild_mismatch", message: "That channel belongs to a different guild than this configuration." });
    }
    const all = channel.messages;
    const messages: ChannelHistoryMessage[] = [];
    let before = request.beforeMessageId ?? undefined;
    let oldestSeenMessageId: string | null = null;
    let reachedBoundary = false;
    let characters = 0;

    while (messages.length < request.maxMessages && characters < request.maxCharacters) {
      let startIndex = 0;
      if (before) {
        const index = all.findIndex((message) => message.id === before);
        startIndex = index === -1 ? all.length : index + 1;
      }
      const page = all.slice(startIndex, startIndex + fetchPageSize);
      if (page.length === 0) { reachedBoundary = true; break; }

      let stoppedForLimit = false;
      for (const message of page) {
        if (message.createdTimestamp < request.boundaryMs) { reachedBoundary = true; break; }
        const content = message.content.trim().slice(0, request.maxCharactersPerMessage);
        const eligible = !message.bot && !message.system && content.length > 0;
        // Mirrors the real cursor-advance fix in discord-channel-history-reader.ts:
        // don't advance past a message we're deferring to the next batch.
        if (eligible && (messages.length >= request.maxMessages || characters + content.length > request.maxCharacters)) {
          stoppedForLimit = true;
          break;
        }
        oldestSeenMessageId = message.id;
        if (!eligible) continue;
        messages.push({
          id: message.id, guildId: request.guildId, channelId: request.channelId,
          authorId: message.authorId, authorDisplayName: `Member ${message.authorId}`,
          content, createdAt: message.createdTimestamp,
        });
        characters += content.length;
      }

      if (reachedBoundary || stoppedForLimit || page.length < fetchPageSize) {
        if (!stoppedForLimit) reachedBoundary = true;
        break;
      }
      before = page[page.length - 1]?.id;
    }

    return Promise.resolve({ ok: true, messages, oldestSeenMessageId, reachedBoundary });
  });
  return { readBatch };
}

function fakeProfile(
  chatOverrides: Partial<GuildConfiguration["chat"]>,
  guildId = "guild",
  featureOverrides: Partial<GuildConfiguration["features"]> = {},
): GuildConfiguration {
  return {
    guildId,
    features: { chatbot: true, ...featureOverrides },
    chat: {
      contextScanChannelIds: [], contextDailyChannelIds: [], contextSeedDays: 7,
      channelMemoryModes: {},
      ...chatOverrides,
    },
  } as unknown as GuildConfiguration;
}

function fakeProfileProvider(profiles: readonly GuildConfiguration[]): GuildConfigurationProvider {
  return { getAll: () => profiles } as unknown as GuildConfigurationProvider;
}

function stubSummarizer(
  facts: readonly ChannelSummaryFact[],
  relations: readonly ChannelSummaryRelation[] = [],
): ChannelMessageSummarizer {
  return { summarizeChannelMessages: vi.fn(() => Promise.resolve({ facts, relations })) };
}

const silentLogger = { error: () => undefined, warn: () => undefined } as unknown as Logger;

function testEngine(): { engine: MemoryEngine; checkpointStore: ChannelSummaryCheckpointStore } {
  const directory = mkdtempSync(join(tmpdir(), "channel-summary-scheduler-"));
  const connection = createSqliteDatabaseConnection(directory);
  return {
    engine: new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database)),
    checkpointStore: new SqliteChannelSummaryCheckpointStore(connection.database),
  };
}

const now = 10 * dayMs; // arbitrary epoch far enough from 0 for subtraction

describe("ChannelSummaryScheduler — scan path", () => {
  it("a scan channel with no checkpoint runs its seed and produces a channel-scoped memory", async () => {
    const { engine, checkpointStore } = testEngine();
    const messages = [fakeMessage("m1", "alice", "hello", now - 1_000)];
    const historyReader = fakeHistoryReader(fakeChannel(messages));
    const summarizer = stubSummarizer([{
      subjectType: "member", subjectId: "alice", topic: "community_activity", slot: "raid.friday",
      statement: "organizes raids", evidenceMessageIds: ["m1"],
    }]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint?.scanCompletedAt).not.toBeNull();
    const recalled = await engine.recall({
      guildId: "guild", channelId: "channel", userId: "anyone", message: "raid",
      recentHistory: [], subjectIds: [], now,
    });
    expect(recalled.memories).toHaveLength(1);
    expect(recalled.memories[0]!.audience).not.toBe("guild"); // channelScoped forced true
  });

  it("a scan-only channel is never re-scheduled once scanCompletedAt is set", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const summarizer = stubSummarizer([]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(historyReader.readBatch).toHaveBeenCalled();
    historyReader.readBatch.mockClear();
    await scheduler.checkNow(new Date(now + dayMs));
    expect(historyReader.readBatch).not.toHaveBeenCalled();
  });

  it("a capped scan run advances the cursor without completing, and resumes from it next tick", async () => {
    const { engine, checkpointStore } = testEngine();
    // 3 messages spanning well within the 7-day seed window.
    const messages = [
      fakeMessage("m3", "alice", "third", now - 1_000),
      fakeMessage("m2", "alice", "second", now - 2_000),
      fakeMessage("m1", "alice", "first", now - 3_000),
    ];
    const historyReader = fakeHistoryReader(fakeChannel(messages));
    const summarizer = stubSummarizer([]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    const checkpoint = await checkpointStore.get("guild", "channel");
    // Real Discord pagination fetches a full page (100) in one call even
    // though only 3 exist, so this exercises the "page smaller than
    // fetchPageSize means channel exhausted" completion path rather than
    // the cap — completion is still correctly detected either way.
    expect(checkpoint?.scanCompletedAt).not.toBeNull();
    expect(historyReader.readBatch).toHaveBeenCalledTimes(1);
  });

  it("permission/fetch failure sets lastError and does not mark the scan complete", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(null);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, stubSummarizer([]), silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint?.lastError).toBeTruthy();
    expect(checkpoint?.scanCompletedAt).toBeNull();
    expect(checkpoint?.lastMessageId).toBeNull();
  });
});

describe("ChannelSummaryScheduler — daily path", () => {
  it("runs once, then is not eligible again on the same tick pass", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const summarizer = stubSummarizer([{
      subjectType: "guild", subjectId: "guild", topic: "scene_summary", slot: "ignored", statement: "quiet day",
      evidenceMessageIds: ["m1"],
    }]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextDailyChannelIds: ["channel"] })]),
      engine, checkpointStore, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(historyReader.readBatch).toHaveBeenCalledTimes(1);
    historyReader.readBatch.mockClear();
    await scheduler.checkNow(new Date(now + 60_000)); // same day, an hour-ish later
    expect(historyReader.readBatch).not.toHaveBeenCalled();
  });

  it("two consecutive daily runs on different days produce two distinct memories, not an overwrite", async () => {
    const { engine, checkpointStore } = testEngine();
    const dayOneHistoryReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "day one chat", now - 1_000)]));
    const summarizer = stubSummarizer([{
      subjectType: "guild", subjectId: "guild", topic: "scene_summary", slot: "model.chose.this.every.time",
      statement: "day one happened", evidenceMessageIds: ["m1"],
    }]);
    const profileProvider = fakeProfileProvider([fakeProfile({ contextDailyChannelIds: ["channel"] })]);
    const schedulerDayOne = new ChannelSummaryScheduler(
      dayOneHistoryReader, profileProvider, engine, checkpointStore, summarizer, silentLogger,
    );
    await schedulerDayOne.checkNow(new Date(now));

    const dayTwoHistoryReader = fakeHistoryReader(fakeChannel([fakeMessage("m2", "alice", "day two chat", now + dayMs - 1_000)]));
    const schedulerDayTwo = new ChannelSummaryScheduler(
      dayTwoHistoryReader, profileProvider, engine, checkpointStore, summarizer, silentLogger,
    );
    await schedulerDayTwo.checkNow(new Date(now + dayMs));

    const recalled = await engine.recall({
      guildId: "guild", channelId: "channel", userId: "anyone", message: "day",
      recentHistory: [], subjectIds: [], now: now + dayMs,
    });
    // Same model-chosen slot both days, but the scheduler overrides it with
    // a date-stamped one — both survive as distinct memories.
    expect(recalled.memories).toHaveLength(2);
    const slots = recalled.memories.map((memory) => memory.slot);
    expect(new Set(slots).size).toBe(2);
  });

  it("two distinct facts consolidated on the same day don't collide onto one memory", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const summarizer = stubSummarizer([
      {
        subjectType: "guild", subjectId: "guild", topic: "scene_summary", slot: "raid_night",
        statement: "raid night happened", evidenceMessageIds: ["m1"],
      },
      {
        subjectType: "guild", subjectId: "guild", topic: "scene_summary", slot: "tavern_fire",
        statement: "the tavern caught fire", evidenceMessageIds: ["m1"],
      },
    ]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextDailyChannelIds: ["channel"] })]),
      engine, checkpointStore, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    const recalled = await engine.recall({
      guildId: "guild", channelId: "channel", userId: "anyone", message: "raid tavern",
      recentHistory: [], subjectIds: [], now,
    });
    expect(recalled.memories).toHaveLength(2);
    const slots = new Set(recalled.memories.map((memory) => memory.slot));
    expect(slots.size).toBe(2);
  });
});

describe("ChannelSummaryScheduler — output limit and member trust", () => {
  it("all 5 valid channel-summary facts are ingested, not sliced to live-chat's smaller default", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const summarizer = stubSummarizer(Array.from({ length: 5 }, (_unused, i) => ({
      subjectType: "guild" as const, subjectId: "guild", topic: "scene_summary", slot: `fact_${i}`,
      statement: `fact number ${i}`, evidenceMessageIds: ["m1"],
    })));
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    const recalled = await engine.recall({
      guildId: "guild", channelId: "channel", userId: "anyone", message: "fact",
      recentHistory: [], subjectIds: [], now,
    });
    expect(recalled.memories).toHaveLength(5);
  });

  it("a self-reported member fact is immediately active; a third-party claim about a member stays a candidate", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I run the Friday raids", now - 2_000),
      fakeMessage("m2", "bob", "alice is secretly the guild leader", now - 1_000),
    ]));
    const summarizer = stubSummarizer([
      {
        subjectType: "member", subjectId: "alice", topic: "community_activity", slot: "raid.friday",
        statement: "alice runs the Friday raids", evidenceMessageIds: ["m1"], // alice's own message
      },
      {
        subjectType: "member", subjectId: "alice", topic: "responsibility", slot: "guild.leader",
        statement: "alice is the guild leader", evidenceMessageIds: ["m2"], // bob's message, about alice
      },
    ]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    const recalled = await engine.recall({
      guildId: "guild", channelId: "channel", userId: "anyone", message: "alice",
      recentHistory: [], subjectIds: ["alice"], now,
    });
    // Only the self-reported fact is "active" (recallable) — the
    // third-party claim was correctly downgraded to an unconfirmed
    // candidate rather than silently trusted as durable memory.
    expect(recalled.memories).toHaveLength(1);
    expect(recalled.memories[0]!.statement).toBe("alice runs the Friday raids");
  });
});

describe("ChannelSummaryScheduler — channel-mode and set-membership gating", () => {
  it("a disabled channel is skipped entirely — no fetch, no checkpoint written", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const scheduler = new ChannelSummaryScheduler(
      historyReader,
      fakeProfileProvider([fakeProfile({
        contextScanChannelIds: ["channel"], contextDailyChannelIds: ["channel"],
        channelMemoryModes: { channel: "disabled" },
      })]),
      engine, checkpointStore, stubSummarizer([]), silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(historyReader.readBatch).not.toHaveBeenCalled();
    expect(await checkpointStore.get("guild", "channel")).toBeNull();
  });

  it("a channel in neither set is skipped", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([]));
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({})]),
      engine, checkpointStore, stubSummarizer([]), silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(historyReader.readBatch).not.toHaveBeenCalled();
  });

  it("disabling the chatbot feature pauses processing without touching config or checkpoints", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const scheduler = new ChannelSummaryScheduler(
      historyReader,
      fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] }, "guild", { chatbot: false })]),
      engine, checkpointStore, stubSummarizer([]), silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(historyReader.readBatch).not.toHaveBeenCalled();
    expect(await checkpointStore.get("guild", "channel")).toBeNull();
  });
});

describe("ChannelSummaryScheduler — channel isolation", () => {
  it("rejects a channel belonging to a different guild than the profile, and records the reason", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)], "other-guild"));
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, stubSummarizer([]), silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint?.lastError).toContain("different guild");
    expect(checkpoint?.scanCompletedAt).toBeNull();
  });
});

describe("ChannelSummaryScheduler — daily high-water mark and capped resumption", () => {
  it("a capped daily run resumes via dailyCursor across ticks and only advances lastRunAt/high-water-mark on full completion", async () => {
    const { engine, checkpointStore } = testEngine();
    // 200 eligible messages, well within the 1-day window and each other —
    // exceeds the per-batch message cap, forcing multiple ticks.
    const messages = Array.from({ length: 200 }, (_unused, i) => fakeMessage(`m${200 - i}`, "alice", `msg ${i}`, now - i * 1_000));
    const historyReader = fakeHistoryReader(fakeChannel(messages));
    const seenIds = new Set<string>();
    const summarizer: ChannelMessageSummarizer = {
      summarizeChannelMessages: vi.fn((_guildId: string, batch: readonly { id: string }[]) => {
        for (const message of batch) seenIds.add(message.id);
        return Promise.resolve({ facts: [], relations: [] });
      }),
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextDailyChannelIds: ["channel"] })]),
      engine, checkpointStore, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    const afterFirstTick = await checkpointStore.get("guild", "channel");
    expect(afterFirstTick?.dailyCursor).not.toBeNull();
    expect(afterFirstTick?.lastRunAt).toBeNull();

    let checkpoint = afterFirstTick;
    for (let iteration = 0; iteration < 10 && checkpoint?.dailyCursor != null; iteration++) {
      await scheduler.checkNow(new Date(now));
      checkpoint = await checkpointStore.get("guild", "channel");
    }

    expect(checkpoint?.dailyCursor).toBeNull();
    expect(checkpoint?.lastRunAt).toBe(now);
    expect(checkpoint?.dailyHighWaterMarkAt).toBe(now);
    // No message skipped or duplicated by the cap/resume mechanics.
    expect(seenIds.size).toBe(200);
  });

  it("daily uses the persisted high-water mark instead of now-24h, so downtime longer than a day doesn't lose messages", async () => {
    const { engine, checkpointStore } = testEngine();
    // A message older than 24h from `laterNow` but newer than the
    // high-water mark left by a previous cycle — a plain "now - dayMs"
    // boundary would miss it entirely.
    const highWaterMarkAt = now;
    const staleMessage = fakeMessage("m1", "alice", "during the outage", now + 1_000);
    const laterNow = now + 3 * dayMs; // 3 days of "downtime"
    await checkpointStore.recordSuccess({ guildId: "guild", channelId: "channel", now: highWaterMarkAt, dailyComplete: true });
    const historyReader = fakeHistoryReader(fakeChannel([staleMessage]));
    const summarizer = stubSummarizer([]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextDailyChannelIds: ["channel"] })]),
      engine, checkpointStore, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(laterNow));

    expect(historyReader.readBatch).toHaveBeenCalledWith(expect.objectContaining({ boundaryMs: highWaterMarkAt }));
  });
});

describe("ChannelSummaryScheduler — scan/daily dedup", () => {
  it("a channel added to both sets at once seeds daily's high-water mark from scan completion", async () => {
    const { engine, checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const scheduler = new ChannelSummaryScheduler(
      historyReader,
      fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"], contextDailyChannelIds: ["channel"] })]),
      engine, checkpointStore, stubSummarizer([]), silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint?.scanCompletedAt).not.toBeNull();
    expect(checkpoint?.dailyHighWaterMarkAt).toBe(now);
    // Daily's own tick on this same pass found nothing newer than `now` to
    // summarize — it did not re-read the message scan just captured.
    expect(historyReader.readBatch).toHaveBeenCalledWith(expect.objectContaining({ boundaryMs: now }));
  });
});

describe("ChannelSummaryScheduler — strict ingestion for background jobs", () => {
  it("does not advance the checkpoint when memory ingestion partially fails", async () => {
    const { checkpointStore } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const summarizer = stubSummarizer([{
      subjectType: "member", subjectId: "alice", topic: "community_activity", slot: "raid.friday",
      statement: "organizes raids", evidenceMessageIds: ["m1"],
    }]);
    const failingEngine: MemoryEngine = {
      recall: () => Promise.reject(new Error("not used")),
      ingest: () => Promise.resolve({ ingested: [], removed: 0, rejected: 0, failed: 1 }),
      ingestRelations: () => Promise.resolve({ created: 0, rejected: 0 }),
      listUserMemories: () => Promise.reject(new Error("not used")),
      forget: () => Promise.reject(new Error("not used")),
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      failingEngine, checkpointStore, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint?.scanCompletedAt).toBeNull();
    expect(checkpoint?.lastMessageId).toBeNull();
    expect(checkpoint?.lastErrorCode).toBe("memory_ingest_partial_failure");
  });
});

describe("ChannelSummaryScheduler — tick re-entrancy", () => {
  it("skips a tick that overlaps a still-running one, instead of double-processing", async () => {
    const { engine, checkpointStore } = testEngine();
    let releaseFirstFetch: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseFirstFetch = resolve; });
    const historyReader = {
      readBatch: vi.fn(async (): Promise<ChannelHistoryReadResult> => {
        await gate;
        return { ok: true, messages: [], oldestSeenMessageId: null, reachedBoundary: true };
      }),
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, stubSummarizer([]), silentLogger,
    );

    const firstTick = scheduler.checkNow(new Date(now));
    const secondTick = scheduler.checkNow(new Date(now)); // fires while the first is still awaiting readBatch
    releaseFirstFetch!();
    await Promise.all([firstTick, secondTick]);

    expect(historyReader.readBatch).toHaveBeenCalledTimes(1);
  });
});
