// Durable per-author queue backing the dedicated personal-memory extraction
// pass (see channel-summary-scheduler.ts's promoteSelfReportsToPrivateMemory
// history — this replaces its in-memory, per-process bookkeeping). Each job
// is one author's own messages from one channel-summary batch, processed
// independently of the channel's own scan/daily checkpoint: enqueuing is
// fire-and-forget from the scheduler's perspective, and a separate
// processing pass (also driven by the scheduler, see
// processPersonalMemoryExtractionJobs) dequeues due work with its own
// bounded concurrency, retry backoff, and dead-letter handling. This is what
// lets one permanently-failing author never block the channel's scan
// progress, and what lets a transient failure survive a process restart
// instead of only surviving within one scheduler instance's lifetime.
export interface PersonalMemoryExtractionJob {
  guildId: string;
  channelId: string;
  batchId: string;
  subjectId: string;
  displayName: string;
  content: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  status: "pending" | "succeeded" | "dead_letter";
}

export interface PersonalMemoryExtractionJobInput {
  guildId: string;
  channelId: string;
  batchId: string;
  subjectId: string;
  displayName: string;
  content: string;
}

export interface PersonalMemoryExtractionQueueStore {
  initialize(): Promise<void>;
  // Serializes extraction and forget/purge mutations for one member within
  // this application instance. All production callers that delete a
  // subject's jobs use this boundary, so an already-dequeued worker either
  // finishes before forgetting begins or observes its deleted row before
  // starting. The durable row remains the cross-restart cancellation state.
  runForSubject<T>(guildId: string, subjectId: string, operation: () => Promise<T>): Promise<T>;
  // Idempotent by (guildId, channelId, batchId, subjectId): a job already
  // present for that identity is left completely untouched — re-enqueuing
  // the same batch (e.g. because an unrelated guild-knowledge or relation
  // ingest is being retried) must never reset an in-progress job's attempt
  // count/backoff, and must never recreate a job that already succeeded —
  // see markSucceeded's own comment on why succeeded rows are kept
  // (not deleted) rather than freed up for re-insertion.
  enqueueMany(jobs: readonly PersonalMemoryExtractionJobInput[], now: number): Promise<void>;
  // Pending jobs (status "pending") whose nextAttemptAt <= now, oldest
  // nextAttemptAt first, capped at limit.
  dequeueDue(limit: number, now: number): Promise<readonly PersonalMemoryExtractionJob[]>;
  // True while this exact durable job identity still exists, regardless of
  // pending/terminal status. Workers use this as a cancellation barrier:
  // deleteForSubject removes the row, so a stale job object returned by an
  // earlier dequeue can detect that forget/purge happened before it writes.
  exists(guildId: string, channelId: string, batchId: string, subjectId: string): Promise<boolean>;
  // Job fully handled — extracted and its resulting proposal (if any)
  // durably ingested. Kept as a status "succeeded" tombstone (content
  // cleared — nothing further needs the raw message text) rather than
  // deleted outright: this batch can still be re-summarized on a later tick
  // if an unrelated step fails afterward (relation ingest, say — see
  // channel-summary-scheduler.ts), which re-enqueues the whole batch: with
  // a deleted row, enqueueMany's idempotency has nothing to conflict with,
  // so it would silently recreate — and this method would then re-run
  // extraction and ingest a SECOND time. See deleteTerminalForBatch for
  // when the tombstone can finally go.
  markSucceeded(guildId: string, channelId: string, batchId: string, subjectId: string): Promise<void>;
  // Still retryable — records the new attempt count, backoff, and error for
  // visibility.
  markFailed(
    guildId: string, channelId: string, batchId: string, subjectId: string,
    attempts: number, nextAttemptAt: number, error: string,
  ): Promise<void>;
  // Retries exhausted — kept as status "dead_letter" (content cleared, same
  // reasoning as markSucceeded — the raw message text is the actual
  // privacy-sensitive payload and nothing further needs it once no more
  // extraction attempts will be made) so it stays visible/countable rather
  // than silently vanishing, but excluded from dequeueDue going forward.
  markDeadLettered(guildId: string, channelId: string, batchId: string, subjectId: string, error: string): Promise<void>;
  // Removes this batch's terminal (succeeded/dead_letter) tombstones —
  // called once a batch's channel-summary checkpoint has conclusively
  // advanced (see channel-summary-scheduler.ts's summarizeAndIngest), at
  // which point this exact batchId will never be read or enqueued again,
  // so the tombstones' only purpose (preventing re-enqueue/re-processing on
  // a retry) no longer applies.
  deleteTerminalForBatch(guildId: string, channelId: string, batchId: string): Promise<void>;
  // Backstop for a batch whose checkpoint never conclusively advances (the
  // channel is removed from scan/daily config, the guild is left, etc.,
  // before deleteTerminalForBatch's normal trigger ever fires) — deletes
  // terminal tombstones whose updatedAt is older than `cutoff`. Run
  // periodically by the scheduler; returns the number of rows removed.
  deleteTerminalOlderThan(cutoff: number): Promise<number>;
  // Removes every job (any channel/batch/status) for this subject in this
  // guild — called when a user is forgotten (/memory forget all) or purged
  // (member departure), so a still-queued or already-succeeded-but-not-yet-
  // cleaned-up job can never later (re)create a private memory for someone
  // who asked to be forgotten. Guild-scoped to match MemberDataPurger and
  // MemoryEngine.forget's own scoping.
  deleteForSubject(guildId: string, subjectId: string): Promise<void>;
}
