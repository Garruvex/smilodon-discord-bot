// "dm": try a DM first, falling back to the origin channel only if DMs are
// closed (the historical default). "channel": always deliver in the origin
// channel — the user has explicitly opted into a visible reminder there.
export type ReminderDelivery = "dm" | "channel";

export interface ReminderRecord {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  message: string;
  delivery: ReminderDelivery;
  // Absolute epoch-ms due time, not a countdown — computed once at creation
  // (now + duration) so a reminder set while the bot is offline for its
  // dueAt isn't lost: the scheduler's next tick after restart sees
  // dueAt <= now and fires it, late but not dropped.
  dueAt: number;
  createdAt: number;
}

export interface ReminderStore {
  initialize(): Promise<void>;
  create(record: Omit<ReminderRecord, "id" | "createdAt">): Promise<ReminderRecord>;
  listForUser(guildId: string, userId: string): Promise<readonly ReminderRecord[]>;
  // Only the reminder's own owner may cancel it — returns false if the id
  // doesn't exist or belongs to someone else, not an error either way.
  cancel(id: string, userId: string): Promise<boolean>;
  listDue(now: number): Promise<readonly ReminderRecord[]>;
  markFired(id: string): Promise<void>;
}
