// Drives both the one-time scan (contextScanChannelIds, via lastMessageId
// as a resumable cursor) and daily consolidation (contextDailyChannelIds,
// via lastRunAt as a once-per-day gate) — see channel-summary-scheduler.ts
// and Plan 2 for the full run-logic rules.
export interface ChannelSummaryCheckpoint {
  guildId: string;
  channelId: string;
  lastMessageId: string | null;
  // Set once the scan reaches the seed-day boundary (or the channel's
  // start) without hitting the per-tick cap — null means either the scan
  // hasn't run yet, or a capped run stopped partway (lastMessageId is
  // non-null in that case, and the next tick resumes from it).
  scanCompletedAt: number | null;
  // Daily's in-progress resume cursor — non-null means a capped daily batch
  // stopped partway and should resume `before` this id next tick. Null
  // whenever no daily cycle is currently in progress.
  dailyCursor: string | null;
  // Lower boundary for the next daily cycle's fetch — null means "use
  // now - 24h" (no cycle has ever completed). Advances to the completion
  // tick's timestamp once a cycle fully reaches its boundary.
  dailyHighWaterMarkAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
  // Bounded, machine-readable companion to lastError (e.g. "guild_mismatch",
  // "missing_view_permission", "summarization_failed") — lets
  // /settings chat context-status and future retry logic branch on error
  // class without parsing the free-text message.
  lastErrorCode: string | null;
  // Last time any batch (scan or daily) ingested successfully — distinct
  // from lastRunAt, which only tracks daily *cycle completion*.
  lastSuccessAt: number | null;
}

export interface ChannelSummaryCheckpointStore {
  initialize(): Promise<void>;
  get(guildId: string, channelId: string): Promise<ChannelSummaryCheckpoint | null>;
  // Advances the checkpoint after a successful tick (including a
  // zero-eligible-messages tick — that's success, not an error) and clears
  // any prior lastError/lastErrorCode. Always sets lastSuccessAt. Scan and
  // daily fields are independent — a channel in both sets passes whichever
  // subset applies to the run that just happened:
  // - `lastMessageId`/`scanComplete`: scan path only.
  // - `dailyCursor`: an in-progress (capped) daily batch's resume point.
  // - `dailyComplete`: a daily cycle fully reached its boundary — clears
  //   dailyCursor and sets dailyHighWaterMarkAt/lastRunAt to `now`.
  // - `dailyHighWaterMarkAt`: explicit override, used only to seed daily's
  //   starting point to a scan's completion time (see
  //   ChannelSummaryScheduler's scan/daily dedup rule) — not set by normal
  //   daily runs, which use `dailyComplete` instead.
  recordSuccess(input: {
    guildId: string;
    channelId: string;
    now: number;
    lastMessageId?: string;
    scanComplete?: boolean;
    dailyCursor?: string;
    dailyComplete?: boolean;
    dailyHighWaterMarkAt?: number;
  }): Promise<void>;
  // Leaves lastMessageId/dailyCursor/dailyHighWaterMarkAt/lastRunAt
  // untouched — retried next tick.
  recordError(guildId: string, channelId: string, code: string, error: string, now: number): Promise<void>;
  // Clears scan progress (lastMessageId, scanCompletedAt) so the next tick
  // re-reads history from the seed boundary — used by context-scan-add's
  // `restart:true`. Leaves daily state untouched: rescanning is scoped to
  // the scan path only.
  resetScan(guildId: string, channelId: string, now: number): Promise<void>;
}
