// Shared, per-channel budget for Discord message edits. Discord rate-limits
// PATCH /channels/:id/messages/:id per channel (every message in a channel
// shares one bucket, plus an undocumented edit sublimit that doesn't show in
// the ratelimit headers), so several features each pacing their own
// messages still add up to 429s. Instead, each message that gets edited
// repeatedly registers a slot here once, then schedules writes through it:
//
//   const slot = scheduler.register({ channelId, key: `${guildId}:lyrics`, priority: 1 });
//   await slot.schedule(async () => { ...build from the latest state, edit if changed...; return true; });
//
// Per channel, at most one write runs at a time and at most `maxEdits`
// writes that reported an edit start within any `windowMs`. When the budget
// is spent, pending slots wait, and a slot that is scheduled again before
// its turn keeps only its newest write — older writes are dropped rather
// than sent late — so each message catches up in one edit carrying its
// latest state. Lower `priority` runs first among pending slots.
//
// A write returns true when it actually sent an edit (it counts against the
// budget) and false when it had nothing to change. A write that throws also
// counts, since the request may have reached Discord; the error is passed
// back to every caller waiting on that write.

export interface ChannelEditSlotOptions {
  channelId: string;
  // Unique per message slot across the whole scheduler, e.g. "<guildId>:lyrics".
  key: string;
  // Lower runs first when several slots in the same channel are pending.
  priority: number;
}

export type ChannelEditWrite = () => Promise<boolean>;

export interface ChannelEditSlot {
  // Resolves once a write covering this request has finished — the one
  // passed here, or a newer one that replaced it before it ran.
  schedule(write: ChannelEditWrite): Promise<void>;
  // Drops any pending write (its callers resolve without it running) and
  // frees the key. Safe to call more than once.
  unregister(): void;
}

export interface ChannelEditSchedulerOptions {
  maxEdits?: number;
  windowMs?: number;
  now?: () => number;
}

// Empirical: production REST logs showed a control-panel channel sustaining
// about three edits per five seconds before Discord started answering 429,
// even while the headers still reported remaining > 0. Watch the debug-level
// "Discord REST response for a message route" log for 429s after changing it.
const defaultMaxEdits = 3;
const defaultWindowMs = 5_000;

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface SlotState {
  options: ChannelEditSlotOptions;
  pending: { write: ChannelEditWrite; waiters: Waiter[]; order: number } | null;
}

interface ChannelState {
  slots: Map<string, SlotState>;
  sentAt: number[];
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ChannelEditScheduler {
  private readonly channels = new Map<string, ChannelState>();
  private readonly keys = new Set<string>();
  private readonly maxEdits: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private order = 0;
  private stopped = false;

  public constructor(options: ChannelEditSchedulerOptions = {}) {
    this.maxEdits = options.maxEdits ?? defaultMaxEdits;
    this.windowMs = options.windowMs ?? defaultWindowMs;
    this.now = options.now ?? Date.now;
  }

  public register(options: ChannelEditSlotOptions): ChannelEditSlot {
    if (this.keys.has(options.key)) throw new Error(`Channel edit slot "${options.key}" is already registered.`);
    this.keys.add(options.key);
    const channel = this.channel(options.channelId);
    const slot: SlotState = { options, pending: null };
    channel.slots.set(options.key, slot);
    let registered = true;

    return {
      schedule: (write): Promise<void> => {
        if (!registered || this.stopped) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const waiters = slot.pending?.waiters ?? [];
          waiters.push({ resolve, reject });
          slot.pending = { write, waiters, order: slot.pending?.order ?? this.order++ };
          // Deferred a microtask so writes scheduled together (e.g. a whole
          // panel refresh) are all pending before one is picked, letting
          // priority decide the first one too.
          queueMicrotask(() => this.drain(options.channelId));
        });
      },
      unregister: (): void => {
        if (!registered) return;
        registered = false;
        this.keys.delete(options.key);
        for (const waiter of slot.pending?.waiters ?? []) waiter.resolve();
        slot.pending = null;
        channel.slots.delete(options.key);
        if (channel.slots.size === 0 && !channel.running) {
          if (channel.timer) clearTimeout(channel.timer);
          this.channels.delete(options.channelId);
        }
      },
    };
  }

  // Shutdown: pending writes are dropped and their callers resolve.
  public stop(): void {
    this.stopped = true;
    for (const channel of this.channels.values()) {
      if (channel.timer) clearTimeout(channel.timer);
      channel.timer = null;
      for (const slot of channel.slots.values()) {
        for (const waiter of slot.pending?.waiters ?? []) waiter.resolve();
        slot.pending = null;
      }
    }
  }

  private channel(channelId: string): ChannelState {
    let channel = this.channels.get(channelId);
    if (!channel) {
      channel = { slots: new Map(), sentAt: [], running: false, timer: null };
      this.channels.set(channelId, channel);
    }
    return channel;
  }

  private drain(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel || channel.running || channel.timer || this.stopped) return;

    const next = this.nextPending(channel);
    if (!next) return;

    const now = this.now();
    channel.sentAt = channel.sentAt.filter((at) => now - at < this.windowMs);
    if (channel.sentAt.length >= this.maxEdits) {
      const waitMs = (channel.sentAt[0] ?? now) + this.windowMs - now;
      channel.timer = setTimeout(() => {
        channel.timer = null;
        this.drain(channelId);
      }, Math.max(0, waitMs));
      channel.timer.unref?.();
      return;
    }

    const pending = next.pending;
    if (!pending) return;
    next.pending = null;
    channel.running = true;
    const startedAt = now;
    void (async (): Promise<void> => {
      try {
        const sent = await pending.write();
        if (sent) channel.sentAt.push(startedAt);
        for (const waiter of pending.waiters) waiter.resolve();
      } catch (error) {
        channel.sentAt.push(startedAt);
        for (const waiter of pending.waiters) waiter.reject(error);
      } finally {
        channel.running = false;
        if (channel.slots.size === 0) this.channels.delete(channelId);
        else this.drain(channelId);
      }
    })();
  }

  private nextPending(channel: ChannelState): SlotState | null {
    let best: SlotState | null = null;
    for (const slot of channel.slots.values()) {
      if (!slot.pending) continue;
      if (
        !best?.pending ||
        slot.options.priority < best.options.priority ||
        (slot.options.priority === best.options.priority && slot.pending.order < best.pending.order)
      ) {
        best = slot;
      }
    }
    return best;
  }
}
