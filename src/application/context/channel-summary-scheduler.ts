import type { Logger } from "pino";

import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { guildKnowledgeLimits, validateGuildKnowledgeCandidates } from "../chat/guild-knowledge-policy.js";
import { resolveChannelMemoryMode } from "../memory/memory-channel-policy.js";
import type { MemoryEngine, ProposedMemory } from "../memory/memory.js";
import type { ChannelHistoryMessage, ChannelHistoryReader } from "./channel-history-reader.js";
import type { ChannelMessageSummarizer, ChannelSummaryFact } from "./channel-message-summarizer.js";
import type { ChannelSummaryCheckpointStore } from "./channel-summary-checkpoint-store.js";

// Hourly — same cadence as BirthdayAnnouncer. Daily's own once-per-~24h
// gate (checkpoint.lastRunAt) means an hourly tick doesn't mean an hourly
// summary; it's just how often we check whether one is due.
const checkIntervalMs = 60 * 60 * 1_000;
const dayMs = 24 * 60 * 60 * 1_000;
// Per-provider-call bounds (Plan 2, Phase 3) — a batch is built to either of
// these limits, whichever comes first, then summarized and ingested as one
// provider call. Kept well under typical context-window budgets so a single
// tick's summarization request is never itself the thing that overflows the
// provider — a large channel simply takes more ticks, not a bigger request.
const maxMessagesPerBatch = 75;
const maxCharactersPerBatch = 40_000;
const maxCharactersPerMessage = 2_000;

// Stable id for a batch of messages, derived from what defines its content —
// mode, guild, channel, and the exact cursor range read. A retry of the same
// batch (e.g. after a partial ingest failure that left the checkpoint
// unadvanced) reproduces the identical id, which the memory repository uses
// to skip re-inserting provenance for facts already recorded from this
// batch. Not a real Discord message id — see summarizeAndIngest's use as
// MemoryIngestInput.sourceMessageId.
function computeBatchId(
  mode: "scan" | "daily", guildId: string, channelId: string, cursorStart: string | null, cursorEnd: string | null,
): string {
  return `batch:${mode}:${guildId}:${channelId}:${cursorStart ?? "start"}-${cursorEnd ?? "end"}`;
}

// Combines the date with the model's own (already validated/normalized)
// slot, rather than replacing it outright — two distinct topics
// consolidated on the same day must land as two distinct memories, not
// overwrite each other under one date-only slot.
function dailySlot(now: number, modelSlot: string): string {
  const date = new Date(now);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `daily.${y}-${m}-${d}.${modelSlot}`;
}

function toKind(topic: string): "fact" | "preference" | "episode" {
  if (topic === "scene_summary") return "episode";
  if (topic === "preference") return "preference";
  return "fact";
}

// Matches validateGuildKnowledgeCandidates' own topic/slot normalization
// (trim + lowercase) so a fact resolved before validation can still be
// looked up by its validated (post-normalization) identity afterward.
function factIdentityKey(subjectType: string, subjectId: string, topic: string, slot: string): string {
  return `${subjectType}|${subjectId}|${topic.trim().toLowerCase()}|${slot.trim().toLowerCase()}`;
}

// A member-subject fact only self-activates when the subject themselves is
// the one who said it — resolved from which of the fact's (batch-validated)
// evidence messages, if any, was authored by the subject. Evidence ids not
// actually present in this batch are ignored (never trusted blindly).
// Non-member subjects don't need an asserter (see resolveInitialStatus's
// consolidation branch), so this only matters for subjectType=member.
function resolveEvidenceAsserter(
  fact: ChannelSummaryFact, validMessageIds: ReadonlySet<string>, authorById: ReadonlyMap<string, string>,
): string | null {
  if (fact.subjectType !== "member") return null;
  for (const messageId of fact.evidenceMessageIds) {
    if (!validMessageIds.has(messageId)) continue;
    const authorId = authorById.get(messageId);
    if (authorId === fact.subjectId) return authorId;
  }
  return null;
}

export class ChannelSummaryScheduler {
  private checkTimer: NodeJS.Timeout | null = null;
  // Guards against an overlapping tick: if a checkNow() call is still
  // processing guilds when the next interval fires (or start()'s immediate
  // call outlives the first interval), a second tick over the same channels
  // could race the first on checkpoint reads/writes and double-run daily
  // consolidation. The interval and start()'s own immediate call both go
  // through this same guard.
  private tickInFlight = false;

  public constructor(
    private readonly historyReader: ChannelHistoryReader,
    private readonly profiles: GuildConfigurationProvider,
    private readonly memoryEngine: MemoryEngine,
    private readonly checkpointStore: ChannelSummaryCheckpointStore,
    private readonly summarizer: ChannelMessageSummarizer,
    private readonly logger: Logger,
  ) {}

  public start(): void {
    void this.checkNow(new Date());
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => void this.checkNow(new Date()), checkIntervalMs);
    this.checkTimer.unref();
  }

  public stop(): void {
    if (!this.checkTimer) return;
    clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  public async checkNow(now: Date): Promise<void> {
    if (this.tickInFlight) {
      this.logger.warn("Channel summary tick skipped — previous tick still running.");
      return;
    }
    this.tickInFlight = true;
    try {
      const nowMs = now.getTime();
      for (const profile of this.profiles.getAll()) {
        // Disabling the chatbot feature pauses all channel-context processing
        // without touching config or checkpoints — re-enabling resumes exactly
        // where the checkpoint left off, no rescan.
        if (!profile.features.chatbot) continue;
        const channelIds = new Set([...profile.chat.contextScanChannelIds, ...profile.chat.contextDailyChannelIds]);
        for (const channelId of channelIds) {
          try {
            await this.processChannel(profile, channelId, nowMs);
          } catch (error) {
            this.logger.error({ error, guildId: profile.guildId, channelId }, "Channel summary check failed");
          }
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private async processChannel(profile: GuildConfiguration, channelId: string, now: number): Promise<void> {
    const mode = resolveChannelMemoryMode(profile.chat.channelMemoryModes, channelId);
    if (mode === "disabled" || mode === "session_only") return;

    const isScan = profile.chat.contextScanChannelIds.includes(channelId);
    const isDaily = profile.chat.contextDailyChannelIds.includes(channelId);
    let checkpoint = await this.checkpointStore.get(profile.guildId, channelId);

    if (isScan && !checkpoint?.scanCompletedAt) {
      await this.runScan(profile, channelId, checkpoint?.lastMessageId ?? null, isDaily && !checkpoint, now);
      // Re-read: if scan just completed and seeded dailyHighWaterMarkAt (the
      // scan/daily dedup rule), the daily check below must see that seeded
      // value on this same tick — not the pre-scan snapshot — or it would
      // immediately re-summarize the same history scan just captured.
      if (isDaily) checkpoint = await this.checkpointStore.get(profile.guildId, channelId);
    }

    if (isDaily) {
      // A capped (in-progress) daily cycle must keep being ticked regardless
      // of the once-per-day gate — otherwise a busy channel that never
      // finishes a cycle within one tick would never make further progress.
      const inProgress = checkpoint?.dailyCursor != null;
      const lastRunAt = checkpoint?.lastRunAt ?? null;
      const due = inProgress || lastRunAt === null || now - lastRunAt >= dayMs;
      if (due) await this.runDaily(profile, channelId, checkpoint?.dailyCursor ?? null, checkpoint?.dailyHighWaterMarkAt ?? null, now);
    }
  }

  private async runScan(
    profile: GuildConfiguration, channelId: string, cursor: string | null, seedsDailyHighWaterMark: boolean, now: number,
  ): Promise<void> {
    const boundaryMs = now - profile.chat.contextSeedDays * dayMs;
    const result = await this.historyReader.readBatch({
      guildId: profile.guildId, channelId, boundaryMs,
      beforeMessageId: cursor, maxMessages: maxMessagesPerBatch,
      maxCharacters: maxCharactersPerBatch, maxCharactersPerMessage: maxCharactersPerMessage,
    });
    if (!result.ok) {
      await this.checkpointStore.recordError(profile.guildId, channelId, result.code, result.message, now);
      return;
    }
    const batchId = computeBatchId("scan", profile.guildId, channelId, cursor, result.oldestSeenMessageId);
    const ingestOk = await this.summarizeAndIngest(profile, channelId, result.messages, "scan", batchId, now);
    if (!ingestOk) return;
    await this.checkpointStore.recordSuccess({
      guildId: profile.guildId, channelId, now,
      ...(result.oldestSeenMessageId ? { lastMessageId: result.oldestSeenMessageId } : {}),
      scanComplete: result.reachedBoundary,
      // Scan/daily dedup (see Plan 2): a channel newly entering both sets at
      // once shouldn't have daily immediately re-summarize the same recent
      // history the scan just captured — seed daily's high-water mark to
      // this scan completion so daily's first cycle starts from here.
      ...(result.reachedBoundary && seedsDailyHighWaterMark ? { dailyHighWaterMarkAt: now } : {}),
    });
  }

  private async runDaily(
    profile: GuildConfiguration, channelId: string, cursor: string | null, highWaterMarkAt: number | null, now: number,
  ): Promise<void> {
    const boundaryMs = highWaterMarkAt ?? (now - dayMs);
    const result = await this.historyReader.readBatch({
      guildId: profile.guildId, channelId, boundaryMs,
      beforeMessageId: cursor, maxMessages: maxMessagesPerBatch,
      maxCharacters: maxCharactersPerBatch, maxCharactersPerMessage: maxCharactersPerMessage,
    });
    if (!result.ok) {
      await this.checkpointStore.recordError(profile.guildId, channelId, result.code, result.message, now);
      return;
    }
    const batchId = computeBatchId("daily", profile.guildId, channelId, cursor, result.oldestSeenMessageId);
    const ingestOk = await this.summarizeAndIngest(profile, channelId, result.messages, "daily", batchId, now);
    if (!ingestOk) return;
    if (result.reachedBoundary) {
      await this.checkpointStore.recordSuccess({ guildId: profile.guildId, channelId, now, dailyComplete: true });
    } else if (result.oldestSeenMessageId) {
      // Capped mid-cycle — resume from here next tick, still same cycle
      // (lastRunAt/dailyHighWaterMarkAt only advance on dailyComplete).
      await this.checkpointStore.recordSuccess({ guildId: profile.guildId, channelId, now, dailyCursor: result.oldestSeenMessageId });
    }
  }

  // Returns false on a summarization/ingest failure (checkpoint already
  // recorded the error, caller should not advance it); true on success,
  // including the "nothing eligible to summarize" case. ChannelHistoryReader
  // already excludes bot/system/empty messages (see
  // discord-channel-history-reader.ts), so every message here is eligible.
  private async summarizeAndIngest(
    profile: GuildConfiguration, channelId: string, messages: readonly ChannelHistoryMessage[],
    path: "scan" | "daily", batchId: string, now: number,
  ): Promise<boolean> {
    if (messages.length === 0) return true;

    const authorIds = new Set(messages.map((message) => message.authorId));
    let facts: readonly ChannelSummaryFact[];
    try {
      facts = await this.summarizer.summarizeChannelMessages(profile.guildId, messages.map((message) => ({
        id: message.id, authorId: message.authorId, authorDisplayName: message.authorDisplayName, content: message.content,
      })));
    } catch (error) {
      await this.checkpointStore.recordError(
        profile.guildId, channelId, "summarization_failed", error instanceof Error ? error.message : "Summarization failed.", now,
      );
      return false;
    }
    if (facts.length === 0) return true;

    // Resolved per-fact, before validation normalizes topic/slot casing —
    // factIdentityKey re-normalizes the same way so the lookup after
    // validation still matches (see resolveEvidenceAsserter/factIdentityKey).
    const messageIds = new Set(messages.map((message) => message.id));
    const authorById = new Map(messages.map((message) => [message.id, message.authorId] as const));
    const asserterByIdentity = new Map(facts.map((fact) => [
      factIdentityKey(fact.subjectType, fact.subjectId, fact.topic, fact.slot),
      resolveEvidenceAsserter(fact, messageIds, authorById),
    ]));

    // channelScoped is always true here — never taken from the model (see
    // memory-channel-policy.ts's resolveMemoryScope, invoked inside
    // memoryEngine.ingest). Passed as a constant into validation purely so
    // validateGuildKnowledgeCandidates' other checks (topic vocabulary,
    // slot format, secret/length, allowedMemberIds) still run. maxCandidates
    // is explicit here — a channel summary batch is allowed up to 5 facts
    // (see channel-message-summarization.ts's schema), not live chat's
    // smaller per-turn default.
    const validated = validateGuildKnowledgeCandidates(
      facts.map((fact) => ({ ...fact, channelScoped: true })),
      {
        guildId: profile.guildId, currentChannelId: channelId, currentUserId: "", allowedMemberIds: authorIds,
        maxCandidates: guildKnowledgeLimits.maxChannelSummaryCandidates,
      },
    );
    if (validated.length === 0) return true;

    const mode = resolveChannelMemoryMode(profile.chat.channelMemoryModes, channelId);
    const proposals: ProposedMemory[] = validated.map((candidate) => ({
      action: "upsert", audience: "guild", kind: toKind(candidate.topic),
      ownerUserId: null, subjectType: candidate.subjectType, subjectId: candidate.subjectId,
      topic: candidate.topic,
      // Daily's slot combines the date with the model's own slot — see
      // dailySlot's own comment for why a date-only slot would collide.
      slot: path === "daily" ? dailySlot(now, candidate.slot) : candidate.slot,
      statement: candidate.statement,
      channelScoped: true,
      // Per-fact trust (Plan 2, Phase 5): only a member-subject fact backed
      // by the subject's own message self-activates; a third-party claim
      // has no matching asserter here (undefined key falls back to null)
      // and stays a "candidate" — see resolveInitialStatus.
      assertedByUserId: asserterByIdentity.get(factIdentityKey(candidate.subjectType, candidate.subjectId, candidate.topic, candidate.slot)) ?? null,
    }));

    let result;
    try {
      result = await this.memoryEngine.ingest({
        guildId: profile.guildId, channelId, channelMode: mode,
        // Stable per-batch id (mode + guild + channel + cursor range) — a
        // retry of the exact same batch (e.g. after a partial failure)
        // reuses this same id, which the repository uses to skip inserting
        // a duplicate memory_sources provenance row. Not a real Discord
        // message id, but sourceMessageId has no other use for a
        // consolidation batch spanning many messages.
        assertedByUserId: null, sourceMessageId: batchId, source: "consolidation", now, proposals,
      });
    } catch (error) {
      await this.checkpointStore.recordError(
        profile.guildId, channelId, "memory_ingest_failed", error instanceof Error ? error.message : "Memory ingest failed.", now,
      );
      return false;
    }
    // A background job must not advance its checkpoint on a partial
    // failure — unlike interactive chat (which logs and continues), a
    // silently-dropped memory here would never be retried once the cursor
    // moves past it.
    if (result.failed > 0) {
      await this.checkpointStore.recordError(
        profile.guildId, channelId, "memory_ingest_partial_failure",
        `${result.failed} of ${validated.length} proposed ${validated.length === 1 ? "memory" : "memories"} failed to persist.`, now,
      );
      return false;
    }
    return true;
  }
}
