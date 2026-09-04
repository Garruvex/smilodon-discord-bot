import type { Logger } from "pino";

import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { normalizeForGroundingCheck, validateMemoryActions } from "../chat/chat-memory-policy.js";
import type { PersonalMemoryExtractionAction, PersonalMemoryExtractor, ProposedMemoryAction } from "../chat/chat-provider.js";
import { guildKnowledgeLimits, validateGuildKnowledgeCandidates } from "../chat/guild-knowledge-policy.js";
import { mapWithConcurrency } from "../concurrency/map-with-concurrency.js";
import { resolveChannelMemoryMode } from "../memory/memory-channel-policy.js";
import type { MemoryEngine, ProposedMemory, ProposedRelation } from "../memory/memory.js";
import type { ChannelHistoryMessage, ChannelHistoryReader } from "./channel-history-reader.js";
import type { ChannelMessageSummarizer, ChannelSummaryFact, ChannelSummaryRelation } from "./channel-message-summarizer.js";
import type { ChannelSummaryCheckpointStore } from "./channel-summary-checkpoint-store.js";
import type { PersonalMemoryExtractionJob, PersonalMemoryExtractionJobInput, PersonalMemoryExtractionQueueStore } from "./personal-memory-extraction-queue.js";

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
// Bounded concurrency for processing due personal-memory extraction jobs
// (see processPersonalMemoryExtractionJobs) — one provider call per job. 5
// keeps a busy tick from bursting dozens of concurrent requests at once
// (rate-limit risk) while still processing meaningfully faster than serial.
// Same order of magnitude as the other best-effort fan-out in this codebase
// (see embedding-batch.ts).
const extractionConcurrency = 5;
// A tick processes at most this many due jobs — bounds a single tick's own
// runtime even when many batches across many channels have accumulated a
// backlog (e.g. after extended downtime). The rest simply wait for the next
// tick; nothing is lost, since jobs are durable (see
// PersonalMemoryExtractionQueueStore).
const maxJobsProcessedPerTick = 200;
// Attempts (across ticks, not a single dequeue) before a job is
// dead-lettered — see PersonalMemoryExtractionQueueStore.markDeadLettered.
// Bounds how long this scheduler keeps retrying one permanently-failing
// author's extraction; queue-durable retry is not the same as
// retry-forever.
const maxExtractionAttempts = 5;
const extractionBackoffBaseMs = 60_000;
const extractionBackoffMaxMs = 60 * 60 * 1_000;
// Backstop retention for a terminal (succeeded/dead_letter) job tombstone —
// see PersonalMemoryExtractionQueueStore.deleteTerminalOlderThan. The
// normal cleanup path (deleteTerminalForBatch, called once a batch's own
// checkpoint conclusively advances) fires far sooner than this; this only
// catches a batch whose checkpoint never gets there at all (the channel is
// removed from scan/daily config, the guild is left, etc.).
const terminalJobRetentionMs = 30 * 24 * 60 * 60 * 1_000;

// Exponential backoff between queue-level retry attempts (not a single
// dequeue's own work) — 1m, 2m, 4m, 8m, capped at 1h. Coarser than the
// scheduler's own hourly tick cadence for later attempts, which is fine:
// the point is spacing out retries against a still-struggling provider, not
// hitting an exact schedule.
function computeExtractionBackoffMs(attempts: number): number {
  return Math.min(extractionBackoffBaseMs * 2 ** (attempts - 1), extractionBackoffMaxMs);
}

// Stable id for a batch of messages, derived from what defines its content —
// mode, guild, channel, and the exact cursor range read. A retry of the same
// batch (e.g. after a partial ingest failure that left the checkpoint
// unadvanced) reproduces the identical id, which the memory repository uses
// to skip re-inserting provenance for facts already recorded from this
// batch, and which the personal-memory extraction queue uses to make
// re-enqueuing the same batch idempotent (see
// PersonalMemoryExtractionQueueStore.enqueueMany). Not a real Discord
// message id — see summarizeAndIngest's use as MemoryIngestInput.sourceMessageId.
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

// Turns a successfully-extracted job's raw model output into validated
// private-memory proposals — shared between the (now-removed) inline path
// and processPersonalMemoryExtractionJobs below. Grounds every action
// against the subject's own message content (never anyone else's — a job's
// `content` is built from ONLY that author's own messages, see
// summarizeAndIngest) via the same aboutSpeaker self-check and sourceQuote
// verbatim-excerpt check live chat's extraction uses (see
// personal-memory-extraction.ts).
function buildPromotionProposals(job: PersonalMemoryExtractionJob, actions: readonly PersonalMemoryExtractionAction[]): ProposedMemory[] {
  const normalizedOwnMessages = normalizeForGroundingCheck(job.content);
  const proposedActions: ProposedMemoryAction[] = actions
    .filter((action) => action.aboutSpeaker)
    .filter((action) => {
      const normalizedQuote = normalizeForGroundingCheck(action.sourceQuote);
      return normalizedQuote.length > 0 && normalizedOwnMessages.includes(normalizedQuote);
    })
    .map((action) => ({ action: action.action, topic: action.topic, slot: action.slot, statement: action.statement, subjectUserId: job.subjectId }));
  const proposals: ProposedMemory[] = [];
  for (const action of validateMemoryActions(proposedActions, new Set([job.subjectId]))) {
    if (action.action !== "upsert") continue;
    proposals.push({
      action: "upsert", audience: "private", kind: action.topic === "preference" ? "preference" : "fact",
      ownerUserId: job.subjectId, subjectType: "member", subjectId: job.subjectId,
      topic: action.topic, slot: action.slot, statement: action.statement!, channelScoped: false,
      assertedByUserId: job.subjectId,
    });
  }
  return proposals;
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
  // The currently (or most recently) executing real tick's promise — set
  // only inside checkNow, after the tickInFlight guard passes, so a
  // redundant overlapping checkNow() call (which returns immediately
  // without doing real work) never overwrites the reference to the tick
  // that's actually still running. See drain().
  private currentTick: Promise<void> | null = null;

  public constructor(
    private readonly historyReader: ChannelHistoryReader,
    private readonly profiles: GuildConfigurationProvider,
    private readonly memoryEngine: MemoryEngine,
    private readonly checkpointStore: ChannelSummaryCheckpointStore,
    // Durable per-author dedicated-extraction queue — see
    // personal-memory-extraction-queue.ts. Decouples a member's
    // personal-memory promotion check entirely from this channel's own
    // scan/daily checkpoint: enqueuing here never blocks it, and a
    // permanently-failing member's dead-lettered job never wedges the
    // channel's scan progress.
    private readonly extractionQueue: PersonalMemoryExtractionQueueStore,
    // Partial<PersonalMemoryExtractor>: optional — a caller that only
    // wants channel summarization (or a provider that never implemented
    // the capability) can omit it, and no jobs are ever enqueued in that
    // case, same as before this existed.
    private readonly summarizer: ChannelMessageSummarizer & Partial<PersonalMemoryExtractor>,
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
    const tick = (async (): Promise<void> => {
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
        // Runs once per tick, after every channel's own scan/daily pass —
        // any jobs those passes just enqueued (nextAttemptAt defaults to
        // "now", immediately due) are processed within this same tick,
        // rather than waiting for the next one.
        try {
          await this.processPersonalMemoryExtractionJobs(nowMs);
        } catch (error) {
          this.logger.error({ error }, "Personal-memory extraction queue processing failed");
        }
        // Cheap backstop cleanup — see deleteTerminalOlderThan's own
        // comment on why this is needed alongside deleteTerminalForBatch.
        try {
          await this.extractionQueue.deleteTerminalOlderThan(nowMs - terminalJobRetentionMs);
        } catch (error) {
          this.logger.error({ error }, "Personal-memory extraction queue tombstone cleanup failed");
        }
      } finally {
        this.tickInFlight = false;
      }
    })();
    this.currentTick = tick;
    return tick;
  }

  // Called from Application.stop() before the process exits — waits for a
  // tick still in flight rather than letting shutdown kill it mid-run. Each
  // tick can now include processing a batch of due personal-memory
  // extraction jobs (see processPersonalMemoryExtractionJobs), which
  // meaningfully lengthened how long a tick can run — without this,
  // persistence closing mid-tick could silently drop a promotion that was
  // about to land. Same race-against-a-hung-call tradeoff as
  // ChatConversationService.drain: bounded by timeoutMs so a stuck provider
  // call can't hang shutdown indefinitely.
  public async drain(timeoutMs = 40_000): Promise<void> {
    if (!this.currentTick) return;
    const tick = this.currentTick;
    const timedOut = new Promise<"timed_out">((resolve) => {
      setTimeout(() => resolve("timed_out"), timeoutMs).unref?.();
    });
    const result = await Promise.race([tick.then(() => "completed" as const), timedOut]);
    if (result === "timed_out") {
      this.logger.warn({ timeoutMs }, "Shutdown drain timed out with a channel-summary tick still in flight");
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
      // (lastRunAt only advances on dailyComplete). Persist the boundary
      // this batch actually used, not just the cursor: when highWaterMarkAt
      // came in null (the channel's very first daily cycle), boundaryMs was
      // computed as `now - dayMs` using THIS tick's `now`. Leaving it
      // unpersisted meant the next tick would recompute it from a later
      // `now`, drifting the boundary forward every tick a capped cycle
      // spans — silently narrowing (and, once reachedBoundary fired against
      // the drifted value, permanently skipping) the window of messages
      // between the original and drifted boundaries. Pinning it here keeps
      // every batch of this cycle reading against the same boundary; it's
      // superseded by the real completion timestamp once dailyComplete
      // fires above.
      await this.checkpointStore.recordSuccess({
        guildId: profile.guildId, channelId, now,
        dailyCursor: result.oldestSeenMessageId,
        dailyHighWaterMarkAt: boundaryMs,
      });
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
    let relations: readonly ChannelSummaryRelation[];
    try {
      const summary = await this.summarizer.summarizeChannelMessages(profile.guildId, messages.map((message) => ({
        id: message.id, authorId: message.authorId, authorDisplayName: message.authorDisplayName, content: message.content,
      })));
      facts = summary.facts;
      relations = summary.relations;
    } catch (error) {
      await this.checkpointStore.recordError(
        profile.guildId, channelId, "summarization_failed", error instanceof Error ? error.message : "Summarization failed.", now,
      );
      return false;
    }
    // No early return on "facts and relations both empty" here — personal-
    // memory extraction jobs below are still enqueued for every author in
    // this batch even when the channel summarizer found nothing
    // community-notable at all (see buildPromotionProposals's own comment
    // on why that check can't be gated on the summarizer's output).

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

    if (proposals.length > 0) {
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
          `${result.failed} of ${proposals.length} proposed ${proposals.length === 1 ? "memory" : "memories"} failed to persist.`, now,
        );
        return false;
      }
    }

    // Enqueues one durable extraction job per distinct author with messages
    // in this batch — not just subjects the channel summarizer happened to
    // produce a candidate fact for. It's tempting to use the summarizer's
    // own output as a pre-filter (skip authors it didn't flag), but that
    // couples this to a genuinely unrelated bottleneck: a batch caps out at
    // maxCandidates (5, see guildKnowledgeLimits) community-notability-
    // focused facts across up to 75 messages and however many distinct
    // speakers — a quiet "I like sushi" from message 40 has no realistic
    // chance of being one of the 5 the summarizer chose to report, even
    // though it's exactly the kind of self-report this promotion path
    // exists to catch.
    //
    // Entirely decoupled from this batch's own success/failure above: this
    // channel's scan/daily checkpoint no longer waits on any of these jobs
    // completing (see processPersonalMemoryExtractionJobs) — a member's
    // promotion check now runs on its own durable, backoff-retried,
    // eventually-dead-lettered schedule, independent of scan progress.
    if (this.summarizer.extractPersonalMemories) {
      const ownMessagesByAuthorId = new Map<string, string[]>();
      const displayNameByAuthorId = new Map<string, string>();
      for (const message of messages) {
        displayNameByAuthorId.set(message.authorId, message.authorDisplayName);
        const own = ownMessagesByAuthorId.get(message.authorId);
        if (own) own.push(message.content);
        else ownMessagesByAuthorId.set(message.authorId, [message.content]);
      }
      const jobs: PersonalMemoryExtractionJobInput[] = [...ownMessagesByAuthorId.entries()]
        .filter(([, ownMessages]) => ownMessages.length > 0)
        .map(([subjectId, ownMessages]) => ({
          guildId: profile.guildId, channelId, batchId, subjectId,
          displayName: displayNameByAuthorId.get(subjectId) ?? subjectId,
          content: ownMessages.join("\n"),
        }));
      if (jobs.length > 0) {
        try {
          await this.extractionQueue.enqueueMany(jobs, now);
        } catch (error) {
          await this.checkpointStore.recordError(
            profile.guildId, channelId, "personal_memory_extraction_enqueue_failed",
            error instanceof Error ? error.message : "Failed to enqueue personal-memory extraction jobs.", now,
          );
          return false;
        }
      }
    }

    if (relations.length > 0) {
      // Reject a relation referencing a subject nothing else in this batch
      // establishes — same spirit as validateGuildKnowledgeCandidates'
      // allowedMemberIds check, applied to relations' two endpoints instead
      // of one subjectId. Checked against `validated` (facts that actually
      // passed policy validation), not the raw model output, so a relation
      // can't piggyback a subject that was itself rejected.
      const knownSubjectIds = new Set<string>([profile.guildId, ...authorIds, ...validated.map((v) => v.subjectId)]);
      const validRelations = relations.filter((relation) =>
        knownSubjectIds.has(relation.fromSubjectId) && knownSubjectIds.has(relation.toSubjectId));
      if (validRelations.length > 0) {
        const proposals: ProposedRelation[] = validRelations.map((relation) => ({
          fromSubjectType: relation.fromSubjectType, fromSubjectId: relation.fromSubjectId,
          predicate: relation.predicate, kind: relation.kind,
          toSubjectType: relation.toSubjectType, toSubjectId: relation.toSubjectId,
        }));
        try {
          // supportingMemoryId is null: a consolidation batch produces
          // several facts/memories, not one, so there's no single memory
          // row that's uniquely "the" support for a relation extracted
          // from the same batch — provenance here is the batch, not a row.
          await this.memoryEngine.ingestRelations({
            guildId: profile.guildId, channelId, channelMode: mode,
            proposals, supportingMemoryId: null, now,
          });
        } catch (error) {
          await this.checkpointStore.recordError(
            profile.guildId, channelId, "relation_ingest_failed",
            error instanceof Error ? error.message : "Relation ingest failed.", now,
          );
          return false;
        }
      }
    }

    // Every step that could still cause this batch to be retried (memory
    // ingest, relation ingest) has now succeeded — this exact batchId will
    // never be enqueued or read again, so any succeeded/dead_letter
    // tombstones it left behind in the extraction queue (see
    // PersonalMemoryExtractionQueueStore.markSucceeded/markDeadLettered) no
    // longer serve any purpose. A failure here doesn't fail the batch
    // itself — it's already conclusively done — the tombstones just live a
    // bit longer until deleteTerminalOlderThan's backstop catches them.
    try {
      await this.extractionQueue.deleteTerminalForBatch(profile.guildId, channelId, batchId);
    } catch (error) {
      this.logger.warn(
        { error, guildId: profile.guildId, channelId, batchId },
        "Failed to clean up settled personal-memory extraction jobs for a completed batch",
      );
    }

    return true;
  }

  // Dequeues and processes due personal-memory extraction jobs across every
  // guild/channel at once (each job already carries its own guildId/
  // channelId, so this doesn't need to iterate profiles the way
  // processChannel does) — see PersonalMemoryExtractionQueueStore. Never
  // throws for an individual job's own failure; only a queue-store-level
  // error (dequeue/mark itself failing) escapes, which the caller logs.
  private async processPersonalMemoryExtractionJobs(now: number): Promise<void> {
    if (!this.summarizer.extractPersonalMemories) return;
    const extractPersonalMemories = this.summarizer.extractPersonalMemories.bind(this.summarizer);
    const jobs = await this.extractionQueue.dequeueDue(maxJobsProcessedPerTick, now);
    if (jobs.length === 0) return;

    // The whole per-job body is wrapped in its own try/catch below — a
    // queue-store call itself failing (fail()'s own markFailed/
    // markDeadLettered, or the final markSucceeded) must never escape this
    // callback. mapWithConcurrency awaits every worker via Promise.all:
    // one rejected callback settles that immediately while OTHER workers'
    // still-in-flight provider calls and DB writes keep running detached,
    // unawaited by anything — the tick would then report done (tickInFlight
    // cleared, currentTick resolved) while real work was still happening
    // underneath it, meaning drain() no longer actually covers it and a new
    // tick could start concurrently with the old one's leftover workers.
    await mapWithConcurrency(jobs, extractionConcurrency, async (job) => {
      try {
        const fail = async (error: unknown, context: string): Promise<void> => {
          const attempts = job.attempts + 1;
          const message = error instanceof Error ? error.message : context;
          if (attempts >= maxExtractionAttempts) {
            this.logger.warn(
              { error, guildId: job.guildId, channelId: job.channelId, subjectId: job.subjectId, attempts },
              "Giving up on this member's personal-memory extraction job after repeated failures",
            );
            await this.extractionQueue.markDeadLettered(job.guildId, job.channelId, job.batchId, job.subjectId, message);
          } else {
            await this.extractionQueue.markFailed(
              job.guildId, job.channelId, job.batchId, job.subjectId,
              attempts, now + computeExtractionBackoffMs(attempts), message,
            );
          }
        };

        let actions;
        try {
          actions = await extractPersonalMemories(job.content, "", { id: job.subjectId, displayName: job.displayName });
        } catch (error) {
          await fail(error, "Personal-memory extraction failed.");
          return;
        }

        const proposals = buildPromotionProposals(job, actions);
        if (proposals.length > 0) {
          // A guild whose configuration no longer exists (e.g. the bot was
          // removed) has nothing meaningful to check a channel mode against
          // — there's no durable write to make on its behalf, so the job is
          // simply done, not failed.
          const profile = this.profiles.find(job.guildId);
          if (profile) {
            const mode = resolveChannelMemoryMode(profile.chat.channelMemoryModes, job.channelId);
            try {
              const result = await this.memoryEngine.ingest({
                guildId: job.guildId, channelId: job.channelId, channelMode: mode,
                assertedByUserId: null, sourceMessageId: job.batchId, source: "consolidation", now, proposals,
              });
              if (result.failed > 0) {
                await fail(null, `${result.failed} of ${proposals.length} proposed ${proposals.length === 1 ? "memory" : "memories"} failed to persist.`);
                return;
              }
            } catch (error) {
              await fail(error, "Failed to persist extracted personal memory.");
              return;
            }
          }
        }
        await this.extractionQueue.markSucceeded(job.guildId, job.channelId, job.batchId, job.subjectId);
      } catch (error) {
        this.logger.error(
          { error, guildId: job.guildId, channelId: job.channelId, subjectId: job.subjectId },
          "Personal-memory extraction job processing failed unexpectedly outside its own error handling",
        );
      }
    });
  }
}
