// Durable backing store for the reaction-reply feature (see
// ReactionReplyScheduler): one row per bot-authored chat reply eligible to
// be evaluated for a reaction-triggered follow-up. Registered eagerly at
// send time (status "watching") rather than discovered lazily from a bare
// reaction event — that's the only way to reliably scope this to "the
// bot's own conversational replies" and nothing else (a music panel
// message, an announcement, a command response) without guessing from the
// reaction event alone. Armed to "pending" on the first reaction (a fixed
// window from then, not a resetting debounce — see the scheduler for why),
// evaluated once when due, and moved to "done" regardless of outcome —
// never re-evaluated after that, however many more reactions arrive later.
export type MessageReactionWatchStatus = "watching" | "pending" | "done";

export interface MessageReactionWatch {
  messageId: string;
  guildId: string;
  channelId: string;
  status: MessageReactionWatchStatus;
  firstReactionAt: number | null;
  dueAt: number | null;
}

export interface MessageReactionWatchStore {
  initialize(): Promise<void>;
  // Idempotent by messageId — a duplicate registration (shouldn't happen in
  // practice) is a no-op rather than resetting an already-armed/evaluated row.
  register(input: { guildId: string; channelId: string; messageId: string }, now: number): Promise<void>;
  // Idempotently transitions a "watching" row to "pending" with
  // dueAt = now + windowMs, on the first reaction only — the WHERE
  // status='watching' guard means a second/third reaction arriving before
  // dueAt (or after, once "done") is naturally a no-op without this caller
  // needing to know whether it's first. Returns false when messageId isn't
  // a registered "watching" row at all (an ordinary bot message the feature
  // never registered, or one already armed/evaluated) — the caller uses
  // this to decide whether the reaction was even relevant.
  armOnFirstReaction(messageId: string, now: number, windowMs: number): Promise<boolean>;
  // Due rows (status='pending' AND dueAt<=now), oldest dueAt first, capped
  // at limit — same shape as PersonalMemoryExtractionQueueStore.dequeueDue.
  dequeueDue(limit: number, now: number): Promise<readonly MessageReactionWatch[]>;
  // Terminal — see the type's own doc comment on why this never re-arms.
  markDone(messageId: string, now: number): Promise<void>;
  // Backstop retention sweep, same role as
  // PersonalMemoryExtractionQueueStore.deleteTerminalOlderThan — removes
  // rows (any status) whose updatedAt predates cutoff, run periodically by
  // the scheduler. Returns the number of rows removed.
  deleteOlderThan(cutoff: number): Promise<number>;
}
