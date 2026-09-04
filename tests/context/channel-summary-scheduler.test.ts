import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import { ChannelSummaryScheduler } from "../../src/application/context/channel-summary-scheduler.js";
import { SqliteChannelSummaryCheckpointStore } from "../../src/infrastructure/persistence/sqlite-channel-summary-checkpoint-store.js";
import { SqlitePersonalMemoryExtractionQueueStore } from "../../src/infrastructure/persistence/sqlite-personal-memory-extraction-queue-store.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import type {
  ChannelHistoryMessage, ChannelHistoryReadRequest, ChannelHistoryReadResult,
} from "../../src/application/context/channel-history-reader.js";
import type { ChannelMessageSummarizer, ChannelSummaryFact, ChannelSummaryRelation } from "../../src/application/context/channel-message-summarizer.js";
import type { PersonalMemoryExtractionAction, PersonalMemoryExtractor } from "../../src/application/chat/chat-provider.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { MemoryEngine } from "../../src/application/memory/memory.js";
import type { ChannelSummaryCheckpointStore } from "../../src/application/context/channel-summary-checkpoint-store.js";
import type { PersonalMemoryExtractionQueueStore } from "../../src/application/context/personal-memory-extraction-queue.js";

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
  return {
    getAll: () => profiles,
    find: (guildId: string) => profiles.find((profile) => profile.guildId === guildId) ?? null,
  } as unknown as GuildConfigurationProvider;
}

function stubSummarizer(
  facts: readonly ChannelSummaryFact[],
  relations: readonly ChannelSummaryRelation[] = [],
  // Optional — see ChannelSummaryScheduler's enqueue-path comment: the real
  // promotion decision goes through this, run independently over just the
  // subject's own messages, not the channel-summary facts above. Keyed by
  // author id so a test can control what each member's own "extraction"
  // finds without conflating different members' evidence.
  extractPersonalMemoriesByAuthorId: ReadonlyMap<string, readonly PersonalMemoryExtractionAction[]> = new Map(),
): ChannelMessageSummarizer & Partial<PersonalMemoryExtractor> {
  return {
    summarizeChannelMessages: vi.fn(() => Promise.resolve({ facts, relations })),
    ...(extractPersonalMemoriesByAuthorId.size > 0
      ? {
          extractPersonalMemories: vi.fn((_userMessage: string, _assistantReply: string, speaker: { id: string; displayName: string }) =>
            Promise.resolve(extractPersonalMemoriesByAuthorId.get(speaker.id) ?? [])),
        }
      : {}),
  };
}

const silentLogger = { error: () => undefined, warn: () => undefined } as unknown as Logger;

function testEngine(): {
  engine: MemoryEngine;
  checkpointStore: ChannelSummaryCheckpointStore;
  extractionQueue: PersonalMemoryExtractionQueueStore;
} {
  const directory = mkdtempSync(join(tmpdir(), "channel-summary-scheduler-"));
  const connection = createSqliteDatabaseConnection(directory);
  return {
    engine: new DefaultMemoryEngine(new SqliteMemoryRepository(connection.database)),
    checkpointStore: new SqliteChannelSummaryCheckpointStore(connection.database),
    extractionQueue: new SqlitePersonalMemoryExtractionQueueStore(connection.database),
  };
}

const now = 10 * dayMs; // arbitrary epoch far enough from 0 for subtraction

describe("ChannelSummaryScheduler — scan path", () => {
  it("a scan channel with no checkpoint runs its seed and produces a channel-scoped memory", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const messages = [fakeMessage("m1", "alice", "hello", now - 1_000)];
    const historyReader = fakeHistoryReader(fakeChannel(messages));
    const summarizer = stubSummarizer([{
      subjectType: "member", subjectId: "alice", topic: "community_activity", slot: "raid.friday",
      statement: "organizes raids", evidenceMessageIds: ["m1"],
    }]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
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
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const summarizer = stubSummarizer([]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(historyReader.readBatch).toHaveBeenCalled();
    historyReader.readBatch.mockClear();
    await scheduler.checkNow(new Date(now + dayMs));
    expect(historyReader.readBatch).not.toHaveBeenCalled();
  });

  it("a capped scan run advances the cursor without completing, and resumes from it next tick", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
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
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
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
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(null);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, stubSummarizer([]), silentLogger,
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
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const summarizer = stubSummarizer([{
      subjectType: "guild", subjectId: "guild", topic: "scene_summary", slot: "ignored", statement: "quiet day",
      evidenceMessageIds: ["m1"],
    }]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextDailyChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(historyReader.readBatch).toHaveBeenCalledTimes(1);
    historyReader.readBatch.mockClear();
    await scheduler.checkNow(new Date(now + 60_000)); // same day, an hour-ish later
    expect(historyReader.readBatch).not.toHaveBeenCalled();
  });

  it("two consecutive daily runs on different days produce two distinct memories, not an overwrite", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const dayOneHistoryReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "day one chat", now - 1_000)]));
    const summarizer = stubSummarizer([{
      subjectType: "guild", subjectId: "guild", topic: "scene_summary", slot: "model.chose.this.every.time",
      statement: "day one happened", evidenceMessageIds: ["m1"],
    }]);
    const profileProvider = fakeProfileProvider([fakeProfile({ contextDailyChannelIds: ["channel"] })]);
    const schedulerDayOne = new ChannelSummaryScheduler(
      dayOneHistoryReader, profileProvider, engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );
    await schedulerDayOne.checkNow(new Date(now));

    const dayTwoHistoryReader = fakeHistoryReader(fakeChannel([fakeMessage("m2", "alice", "day two chat", now + dayMs - 1_000)]));
    const schedulerDayTwo = new ChannelSummaryScheduler(
      dayTwoHistoryReader, profileProvider, engine, checkpointStore, extractionQueue, summarizer, silentLogger,
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
    const { engine, checkpointStore, extractionQueue } = testEngine();
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
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
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
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const summarizer = stubSummarizer(Array.from({ length: 5 }, (_unused, i) => ({
      subjectType: "guild" as const, subjectId: "guild", topic: "scene_summary", slot: `fact_${i}`,
      statement: `fact number ${i}`, evidenceMessageIds: ["m1"],
    })));
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    const recalled = await engine.recall({
      guildId: "guild", channelId: "channel", userId: "anyone", message: "fact",
      recentHistory: [], subjectIds: [], now,
    });
    expect(recalled.memories).toHaveLength(5);
  });

  it("a self-reported member fact is immediately active; a third-party claim about a member stays a candidate", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
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
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
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

describe("ChannelSummaryScheduler — promoting self-reports to portable private memory", () => {
  it("a self-reported fact on a portable topic (public_interest) also becomes private memory that follows the user across channels", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I really like green apples", now - 1_000),
    ]));
    const summarizer = stubSummarizer(
      [{
        subjectType: "member", subjectId: "alice", topic: "public_interest", slot: "food.fruit",
        statement: "likes green apples", evidenceMessageIds: ["m1"], // alice's own message
      }],
      [],
      // The promotion decision is re-derived independently over alice's own
      // messages (see ChannelSummaryScheduler's personal-memory extraction
      // queue) — this is what actually drives the private write, not the
      // fact above. Jobs default to being immediately due, so this
      // resolves within the same checkNow() tick that enqueued it.
      new Map([["alice", [
        { action: "upsert", aboutSpeaker: true, sourceQuote: "I really like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
      ]]]),
    );
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    const stored = await engine.listUserMemories("guild", "alice");
    expect(stored).toMatchObject([{ audience: "private", topic: "preference", statement: "likes green apples" }]);
    // Recalled from an entirely different channel — proof it's not
    // channel-scoped guild knowledge but genuinely portable private memory.
    const recalledElsewhere = await engine.recall({
      guildId: "guild", channelId: "some-other-channel", userId: "alice", message: "fruit",
      recentHistory: [], subjectIds: ["alice"], now,
    });
    expect(recalledElsewhere.memories.some((memory) => memory.statement === "likes green apples" && memory.audience === "private")).toBe(true);
  });

  it("promotion is skipped entirely when the configured provider has no extraction capability", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I run the Friday raids", now - 1_000),
    ]));
    // No extractPersonalMemoriesByAuthorId map passed — stubSummarizer
    // omits the capability entirely, same as a provider that never
    // implemented it (see ChannelSummaryScheduler's constructor comment).
    const summarizer = stubSummarizer([{
      subjectType: "member", subjectId: "alice", topic: "community_activity", slot: "raid.friday",
      statement: "organizes raids", evidenceMessageIds: ["m1"], // alice's own message
    }]);
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    await expect(engine.listUserMemories("guild", "alice")).resolves.toHaveLength(0);
    await expect(extractionQueue.dequeueDue(10, now)).resolves.toHaveLength(0);
  });

  it("promotes a self-report even when the channel summarizer found nothing community-notable in the whole batch", async () => {
    // The exact gap this closes: a quiet batch (nothing worth a
    // guild-knowledge candidate) must not skip promotion — it isn't gated
    // on the summarizer having produced anything at all.
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I really like green apples", now - 1_000),
    ]));
    const summarizer = stubSummarizer(
      [], [],
      new Map([["alice", [
        { action: "upsert", aboutSpeaker: true, sourceQuote: "I really like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
      ]]]),
    );
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    const stored = await engine.listUserMemories("guild", "alice");
    expect(stored).toMatchObject([{ audience: "private", statement: "likes green apples" }]);
  });

  it("promotes a self-report from a member the summarizer's 5-fact cap left out entirely", async () => {
    // A batch can have far more distinct speakers than the summarizer's
    // maxCandidates allows to report on — bob's own message here never
    // becomes a summary candidate at all, but promotion still runs for him
    // since it isn't gated on being one of the summarizer's picks.
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m2", "bob", "I love pizza", now - 1_000),
      fakeMessage("m1", "alice", "the tavern is quite busy today", now - 2_000),
    ]));
    const summarizer = stubSummarizer(
      // Only alice made it into the summarizer's output — bob's message
      // never generated a candidate fact at all.
      [{
        subjectType: "guild", subjectId: "guild", topic: "community", slot: "tavern.busy",
        statement: "the tavern is busy", evidenceMessageIds: ["m1"],
      }],
      [],
      new Map([["bob", [
        { action: "upsert", aboutSpeaker: true, sourceQuote: "I love pizza", topic: "preference", slot: "food.pizza", statement: "loves pizza" },
      ]]]),
    );
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    const stored = await engine.listUserMemories("guild", "bob");
    expect(stored).toMatchObject([{ audience: "private", statement: "loves pizza" }]);
  });

  it("a third-party claim never promotes to the person it's about — alice has no messages in the batch, so she's never even checked", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "bob", "alice apparently loves green apples", now - 1_000),
    ]));
    const summarizer = stubSummarizer(
      [{
        subjectType: "member", subjectId: "alice", topic: "public_interest", slot: "food.fruit",
        statement: "likes green apples", evidenceMessageIds: ["m1"], // bob's message, about alice
      }],
      [],
      // bob's own message is about alice, not himself — a correctly
      // behaving extractor recognizes that and returns nothing for him.
      new Map([["bob", []]]),
    );
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    await expect(engine.listUserMemories("guild", "alice")).resolves.toHaveLength(0);
    await expect(engine.listUserMemories("guild", "bob")).resolves.toHaveLength(0);
  });

  it("a subject's own unrelated message cited as evidence alongside someone else's claim about them does not get promoted as self-report", async () => {
    // Reproduces the exact failure mode the independent-extraction check
    // exists to close: resolveEvidenceAsserter only asks "did the subject
    // author ANY of the cited evidence messages", so bob's own "hello"
    // being cited alongside alice's actual claim is enough to pass that
    // (weak) pre-filter. Promotion must not trust it — the real decision
    // runs an independent extraction over bob's own messages only.
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m2", "alice", "bob loves pizza", now - 1_000),
      fakeMessage("m1", "bob", "hello", now - 2_000),
    ]));
    const summarizer = stubSummarizer(
      [{
        subjectType: "member", subjectId: "bob", topic: "public_interest", slot: "food.pizza",
        statement: "loves pizza", evidenceMessageIds: ["m1", "m2"],
      }],
      [],
      // bob's own messages ("hello") genuinely contain no such claim, so
      // the independent extraction check correctly finds nothing.
      new Map([["bob", []]]),
    );
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    await expect(engine.listUserMemories("guild", "bob")).resolves.toHaveLength(0);
  });

  it("still rejects a promotion whose sourceQuote isn't actually in the subject's own messages, even if aboutSpeaker is (incorrectly) true", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I really like green apples", now - 1_000),
    ]));
    const summarizer = stubSummarizer(
      [{
        subjectType: "member", subjectId: "alice", topic: "public_interest", slot: "food.fruit",
        statement: "likes green apples", evidenceMessageIds: ["m1"],
      }],
      [],
      // sourceQuote here isn't a real excerpt of alice's own messages —
      // grounding rejects it regardless of aboutSpeaker.
      new Map([["alice", [
        { action: "upsert", aboutSpeaker: true, sourceQuote: "alice organizes the friday raids", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
      ]]]),
    );
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    await expect(engine.listUserMemories("guild", "alice")).resolves.toHaveLength(0);
  });
});

describe("ChannelSummaryScheduler — durable personal-memory extraction queue", () => {
  it("advances the channel's own checkpoint even while a member's extraction job is still pending retry — the two are fully decoupled", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I really like green apples", now - 1_000),
    ]));
    const extractPersonalMemories = vi.fn((): Promise<readonly PersonalMemoryExtractionAction[]> => Promise.reject(new Error("still down")));
    const summarizer: ChannelMessageSummarizer & Partial<PersonalMemoryExtractor> = {
      summarizeChannelMessages: vi.fn(() => Promise.resolve({ facts: [], relations: [] })),
      extractPersonalMemories,
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));

    // The channel's own scan completed regardless of the extraction job's
    // outcome — a permanently-failing member's job can never wedge scan
    // progress, unlike the old (removed) checkpoint-blocking behavior.
    expect((await checkpointStore.get("guild", "channel"))?.scanCompletedAt).not.toBeNull();
    expect(extractPersonalMemories).toHaveBeenCalledTimes(1);
    // The job itself is still alive, just backing off — not lost.
    const dueAfterBackoff = await extractionQueue.dequeueDue(10, now + 61_000);
    expect(dueAfterBackoff).toHaveLength(1);
    expect(dueAfterBackoff[0]!.subjectId).toBe("alice");
  });

  it("retries a transient extraction failure on a later tick once backoff has elapsed, instead of permanently skipping that member", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I really like green apples", now - 1_000),
    ]));
    let calls = 0;
    const summarizer: ChannelMessageSummarizer & Partial<PersonalMemoryExtractor> = {
      summarizeChannelMessages: vi.fn(() => Promise.resolve({ facts: [], relations: [] })),
      extractPersonalMemories: vi.fn((): Promise<readonly PersonalMemoryExtractionAction[]> => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("transient network error"));
        return Promise.resolve([
          { action: "upsert", aboutSpeaker: true, sourceQuote: "I really like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
        ]);
      }),
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(calls).toBe(1);
    await expect(engine.listUserMemories("guild", "alice")).resolves.toHaveLength(0);

    // Not due yet — the first failure's backoff is 1 minute.
    await scheduler.checkNow(new Date(now + 1_000));
    expect(calls).toBe(1);

    // Backoff elapsed — retried, and this time it succeeds.
    await scheduler.checkNow(new Date(now + 61_000));
    expect(calls).toBe(2);
    const stored = await engine.listUserMemories("guild", "alice");
    expect(stored).toMatchObject([{ audience: "private", statement: "likes green apples" }]);
  });

  it("dead-letters a job after repeated cross-tick failures, without ever blocking the channel's own checkpoint", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I really like green apples", now - 1_000),
    ]));
    const extractPersonalMemories = vi.fn((): Promise<readonly PersonalMemoryExtractionAction[]> => Promise.reject(new Error("permanently down")));
    const summarizer: ChannelMessageSummarizer & Partial<PersonalMemoryExtractor> = {
      summarizeChannelMessages: vi.fn(() => Promise.resolve({ facts: [], relations: [] })),
      extractPersonalMemories,
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    let tickNow = now;
    await scheduler.checkNow(new Date(tickNow));
    expect((await checkpointStore.get("guild", "channel"))?.scanCompletedAt).not.toBeNull();
    expect(extractPersonalMemories).toHaveBeenCalledTimes(1);

    // maxExtractionAttempts is 5 — 4 more failures (each after that
    // attempt's own exponential backoff has elapsed) exhausts it.
    for (const backoffMs of [60_000, 120_000, 240_000, 480_000]) {
      tickNow += backoffMs;
      await scheduler.checkNow(new Date(tickNow));
    }

    expect(extractPersonalMemories).toHaveBeenCalledTimes(5);
    await expect(engine.listUserMemories("guild", "alice")).resolves.toHaveLength(0);

    // Dead-lettered — a further tick, even well past any backoff, must
    // never call it again.
    tickNow += dayMs;
    await scheduler.checkNow(new Date(tickNow));
    expect(extractPersonalMemories).toHaveBeenCalledTimes(5);
  });

  it("never re-invokes extraction for an already-succeeded job, even while a co-batched member's job keeps retrying", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I really like green apples", now - 2_000),
      fakeMessage("m2", "bob", "I love pizza", now - 1_000),
    ]));
    let bobShouldFail = true;
    const extractPersonalMemories = vi.fn(
      (_userMessage: string, _assistantReply: string, speaker: { id: string }): Promise<readonly PersonalMemoryExtractionAction[]> => {
        if (speaker.id === "bob" && bobShouldFail) return Promise.reject(new Error("still down"));
        if (speaker.id === "bob") {
          return Promise.resolve([
            { action: "upsert", aboutSpeaker: true, sourceQuote: "I love pizza", topic: "preference", slot: "food.pizza", statement: "loves pizza" },
          ]);
        }
        return Promise.resolve([
          { action: "upsert", aboutSpeaker: true, sourceQuote: "I really like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
        ]);
      },
    );
    const summarizer: ChannelMessageSummarizer & Partial<PersonalMemoryExtractor> = {
      summarizeChannelMessages: vi.fn(() => Promise.resolve({ facts: [], relations: [] })),
      extractPersonalMemories,
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    const aliceCallsAfterTick1 = extractPersonalMemories.mock.calls.filter((call) => call[2].id === "alice").length;
    expect(aliceCallsAfterTick1).toBe(1);
    await expect(engine.listUserMemories("guild", "alice")).resolves.toHaveLength(1);

    // Bob's retry only becomes due once his own backoff has elapsed.
    bobShouldFail = false;
    await scheduler.checkNow(new Date(now + 60_000));

    const bobStored = await engine.listUserMemories("guild", "bob");
    expect(bobStored).toMatchObject([{ audience: "private", statement: "loves pizza" }]);
    const aliceCallsFinal = extractPersonalMemories.mock.calls.filter((call) => call[2].id === "alice").length;
    expect(aliceCallsFinal).toBe(1);
  });

  it("a relation-ingest failure that retries the batch does not re-extract an author whose job already succeeded", async () => {
    // markSucceeded keeps a "succeeded" tombstone rather than deleting the
    // row (see PersonalMemoryExtractionQueueStore) specifically so a later,
    // unrelated failure in the SAME batch (relation ingest here) that
    // forces a retry doesn't let enqueueMany silently recreate — and this
    // scheduler re-process — a job that already completed.
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I really like green apples", now - 2_000),
      fakeMessage("m2", "bob", "I follow alice around town", now - 1_000),
    ]));
    let extractCalls = 0;
    const summarizer: ChannelMessageSummarizer & Partial<PersonalMemoryExtractor> = {
      summarizeChannelMessages: vi.fn(() => Promise.resolve({
        facts: [],
        relations: [{
          fromSubjectType: "member" as const, fromSubjectId: "bob", predicate: "allied_with" as const, kind: "association" as const,
          toSubjectType: "member" as const, toSubjectId: "alice",
        }],
      })),
      extractPersonalMemories: vi.fn((_userMessage: string, _assistantReply: string, speaker: { id: string }): Promise<readonly PersonalMemoryExtractionAction[]> => {
        if (speaker.id !== "alice") return Promise.resolve([]);
        extractCalls += 1;
        return Promise.resolve([
          { action: "upsert", aboutSpeaker: true, sourceQuote: "I really like green apples", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
        ]);
      }),
    };
    let relationAttempts = 0;
    const flakyRelationsEngine: MemoryEngine = {
      recall: (input) => engine.recall(input),
      ingest: (input) => engine.ingest(input),
      ingestRelations: (input) => {
        relationAttempts += 1;
        if (relationAttempts === 1) return Promise.reject(new Error("relation store unavailable"));
        return engine.ingestRelations(input);
      },
      listUserMemories: (guildId, userId) => engine.listUserMemories(guildId, userId),
      forget: (input) => engine.forget(input),
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      flakyRelationsEngine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(extractCalls).toBe(1);
    await expect(engine.listUserMemories("guild", "alice")).resolves.toHaveLength(1);
    // Relation ingest failed — the batch must be retried next tick.
    expect((await checkpointStore.get("guild", "channel"))?.scanCompletedAt).toBeNull();

    // Retry: the same batch (same batchId) is re-read and re-enqueued, but
    // alice's job is already a "succeeded" tombstone — it must not be
    // re-extracted.
    await scheduler.checkNow(new Date(now));
    expect(extractCalls).toBe(1);
    expect((await checkpointStore.get("guild", "channel"))?.scanCompletedAt).not.toBeNull();

    // The batch is now conclusively checkpointed — its tombstones were
    // cleaned up (deleteTerminalForBatch), so the age-based backstop finds
    // nothing left over to remove.
    await expect(extractionQueue.deleteTerminalOlderThan(now + 1_000_000)).resolves.toBe(0);
  });

  it("a queue-store error completing one job does not let the tick report done while sibling jobs are still in flight", async () => {
    // mapWithConcurrency awaits every worker via Promise.all — without a
    // try/catch around each job's own body, one job's markSucceeded call
    // rejecting would settle that Promise.all (and therefore this whole
    // tick) immediately, while sibling workers (still doing real provider
    // calls and DB writes) kept running detached, unawaited by anything —
    // checkNow() would resolve, tickInFlight would clear, and drain() would
    // no longer actually cover that leftover work. bob's own extraction/
    // ingest/markSucceeded all resolve immediately (his markSucceeded is
    // the one that rejects); alice and carol are held behind a gate so the
    // test can observe whether the tick waits for them.
    const { engine, checkpointStore, extractionQueue: realQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([
      fakeMessage("m1", "alice", "I really like green apples", now - 3_000),
      fakeMessage("m2", "bob", "I love pizza", now - 2_000),
      fakeMessage("m3", "carol", "I enjoy hiking", now - 1_000),
    ]));
    const factsBySpeaker: Record<string, { sourceQuote: string; slot: string; statement: string }> = {
      alice: { sourceQuote: "I really like green apples", slot: "food.fruit", statement: "likes green apples" },
      bob: { sourceQuote: "I love pizza", slot: "food.pizza", statement: "loves pizza" },
      carol: { sourceQuote: "I enjoy hiking", slot: "activity.hiking", statement: "enjoys hiking" },
    };
    let releaseGatedAuthors: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseGatedAuthors = resolve; });
    const summarizer: ChannelMessageSummarizer & Partial<PersonalMemoryExtractor> = {
      summarizeChannelMessages: vi.fn(() => Promise.resolve({ facts: [], relations: [] })),
      extractPersonalMemories: vi.fn(async (_userMessage: string, _assistantReply: string, speaker: { id: string }): Promise<readonly PersonalMemoryExtractionAction[]> => {
        if (speaker.id !== "bob") await gate;
        const fact = factsBySpeaker[speaker.id]!;
        return [{ action: "upsert", aboutSpeaker: true, sourceQuote: fact.sourceQuote, topic: "preference", slot: fact.slot, statement: fact.statement }];
      }),
    };
    const brokenQueue: PersonalMemoryExtractionQueueStore = {
      initialize: () => realQueue.initialize(),
      enqueueMany: (jobs, enqueueNow) => realQueue.enqueueMany(jobs, enqueueNow),
      dequeueDue: (limit, dequeueNow) => realQueue.dequeueDue(limit, dequeueNow),
      markSucceeded: (guildId, channelId, batchId, subjectId) =>
        subjectId === "bob" ? Promise.reject(new Error("queue store unavailable")) : realQueue.markSucceeded(guildId, channelId, batchId, subjectId),
      markFailed: (guildId, channelId, batchId, subjectId, attempts, nextAttemptAt, error) =>
        realQueue.markFailed(guildId, channelId, batchId, subjectId, attempts, nextAttemptAt, error),
      markDeadLettered: (guildId, channelId, batchId, subjectId, error) =>
        realQueue.markDeadLettered(guildId, channelId, batchId, subjectId, error),
      deleteTerminalForBatch: (guildId, channelId, batchId) => realQueue.deleteTerminalForBatch(guildId, channelId, batchId),
      deleteTerminalOlderThan: (cutoff) => realQueue.deleteTerminalOlderThan(cutoff),
      deleteForSubject: (guildId, subjectId) => realQueue.deleteForSubject(guildId, subjectId),
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, brokenQueue, summarizer, silentLogger,
    );

    const tick = scheduler.checkNow(new Date(now));
    let tickDone = false;
    void tick.then(() => { tickDone = true; });

    // Give bob's ungated chain (extract -> ingest -> the rejecting
    // markSucceeded) every opportunity to settle.
    for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
    await expect(engine.listUserMemories("guild", "bob")).resolves.toHaveLength(1);
    // The tick must NOT be done yet — alice and carol are still gated, and
    // bob's own queue-store failure must not have short-circuited the wait
    // for them.
    expect(tickDone).toBe(false);

    releaseGatedAuthors!();
    await tick;
    expect(tickDone).toBe(true);

    await expect(engine.listUserMemories("guild", "alice")).resolves.toHaveLength(1);
    await expect(engine.listUserMemories("guild", "carol")).resolves.toHaveLength(1);
  });

  it("bounds concurrent per-author extraction calls instead of firing one provider call per author all at once", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const authorCount = 12;
    const messages = Array.from({ length: authorCount }, (_unused, i) =>
      fakeMessage(`m${i}`, `author${i}`, `message ${i}`, now - (authorCount - i) * 1_000));
    const historyReader = fakeHistoryReader(fakeChannel(messages));
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: (() => void)[] = [];
    const summarizer: ChannelMessageSummarizer & Partial<PersonalMemoryExtractor> = {
      summarizeChannelMessages: vi.fn(() => Promise.resolve({ facts: [], relations: [] })),
      extractPersonalMemories: vi.fn((): Promise<readonly PersonalMemoryExtractionAction[]> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          releases.push(() => { inFlight -= 1; resolve([]); });
        });
      }),
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    const tick = scheduler.checkNow(new Date(now));
    // Let the scan/enqueue phase and the first round of dequeued work start.
    for (let round = 0; round < 4 && maxInFlight === 0; round++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // All available worker "slots" have started their first call — with 12
    // authors and no bound, this would be 12; bounded concurrency caps it
    // well below that (see extractionConcurrency in the scheduler).
    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThan(authorCount);

    for (let round = 0; round < authorCount; round++) {
      while (releases.length > 0) releases.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await tick;

    expect(maxInFlight).toBeLessThan(authorCount);
  });
});

describe("ChannelSummaryScheduler — channel-mode and set-membership gating", () => {
  it("a disabled channel is skipped entirely — no fetch, no checkpoint written", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const scheduler = new ChannelSummaryScheduler(
      historyReader,
      fakeProfileProvider([fakeProfile({
        contextScanChannelIds: ["channel"], contextDailyChannelIds: ["channel"],
        channelMemoryModes: { channel: "disabled" },
      })]),
      engine, checkpointStore, extractionQueue, stubSummarizer([]), silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(historyReader.readBatch).not.toHaveBeenCalled();
    expect(await checkpointStore.get("guild", "channel")).toBeNull();
  });

  it("a channel in neither set is skipped", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([]));
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({})]),
      engine, checkpointStore, extractionQueue, stubSummarizer([]), silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(historyReader.readBatch).not.toHaveBeenCalled();
  });

  it("disabling the chatbot feature pauses processing without touching config or checkpoints", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const scheduler = new ChannelSummaryScheduler(
      historyReader,
      fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] }, "guild", { chatbot: false })]),
      engine, checkpointStore, extractionQueue, stubSummarizer([]), silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    expect(historyReader.readBatch).not.toHaveBeenCalled();
    expect(await checkpointStore.get("guild", "channel")).toBeNull();
  });
});

describe("ChannelSummaryScheduler — channel isolation", () => {
  it("rejects a channel belonging to a different guild than the profile, and records the reason", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)], "other-guild"));
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, stubSummarizer([]), silentLogger,
    );

    await scheduler.checkNow(new Date(now));
    const checkpoint = await checkpointStore.get("guild", "channel");
    expect(checkpoint?.lastError).toContain("different guild");
    expect(checkpoint?.scanCompletedAt).toBeNull();
  });
});

describe("ChannelSummaryScheduler — daily high-water mark and capped resumption", () => {
  it("a capped daily run resumes via dailyCursor across ticks and only advances lastRunAt/high-water-mark on full completion", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
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
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
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
    const { engine, checkpointStore, extractionQueue } = testEngine();
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
      engine, checkpointStore, extractionQueue, summarizer, silentLogger,
    );

    await scheduler.checkNow(new Date(laterNow));

    expect(historyReader.readBatch).toHaveBeenCalledWith(expect.objectContaining({ boundaryMs: highWaterMarkAt }));
  });
});

describe("ChannelSummaryScheduler — scan/daily dedup", () => {
  it("a channel added to both sets at once seeds daily's high-water mark from scan completion", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const historyReader = fakeHistoryReader(fakeChannel([fakeMessage("m1", "alice", "hello", now - 1_000)]));
    const scheduler = new ChannelSummaryScheduler(
      historyReader,
      fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"], contextDailyChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, stubSummarizer([]), silentLogger,
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
    const { checkpointStore, extractionQueue } = testEngine();
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
      failingEngine, checkpointStore, extractionQueue, summarizer, silentLogger,
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
    const { engine, checkpointStore, extractionQueue } = testEngine();
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
      engine, checkpointStore, extractionQueue, stubSummarizer([]), silentLogger,
    );

    const firstTick = scheduler.checkNow(new Date(now));
    const secondTick = scheduler.checkNow(new Date(now)); // fires while the first is still awaiting readBatch
    releaseFirstFetch!();
    await Promise.all([firstTick, secondTick]);

    expect(historyReader.readBatch).toHaveBeenCalledTimes(1);
  });
});

describe("ChannelSummaryScheduler — drain", () => {
  it("waits for a tick still in flight instead of letting shutdown race it", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    let releaseFetch: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const historyReader = {
      readBatch: vi.fn(async (): Promise<ChannelHistoryReadResult> => {
        await gate;
        return { ok: true, messages: [], oldestSeenMessageId: null, reachedBoundary: true };
      }),
    };
    const scheduler = new ChannelSummaryScheduler(
      historyReader, fakeProfileProvider([fakeProfile({ contextScanChannelIds: ["channel"] })]),
      engine, checkpointStore, extractionQueue, stubSummarizer([]), silentLogger,
    );

    void scheduler.checkNow(new Date(now));
    const drained = scheduler.drain();
    let drainedYet = false;
    void drained.then(() => { drainedYet = true; });
    await Promise.resolve();
    expect(drainedYet).toBe(false);

    releaseFetch!();
    await drained;
    expect(drainedYet).toBe(true);
  });

  it("resolves immediately when no tick has ever run", async () => {
    const { engine, checkpointStore, extractionQueue } = testEngine();
    const scheduler = new ChannelSummaryScheduler(
      { readBatch: vi.fn() }, fakeProfileProvider([]), engine, checkpointStore, extractionQueue, stubSummarizer([]), silentLogger,
    );

    await expect(scheduler.drain()).resolves.toBeUndefined();
  });
});
