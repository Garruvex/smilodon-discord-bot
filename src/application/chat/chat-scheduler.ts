import { SocialOutputSuppressed } from "./message-origin-store.js";

export interface ChatActivityLimits {
  evaluationCooldownMs: number;
  textCooldownMs: number;
  reactionCooldownMs: number;
  textPerWindow: number;
  reactionsPerWindow: number;
  concurrency?: number;
  optionalTurnsPerWindow?: number;
  optionalCallCost?: number;
  continuation?: boolean;
  continuationIntervalMs?: number;
  exchangeId?: string | undefined;
  continuationPerExchange?: number;
  continuationPerWindow?: number;
}

export const balancedChatLimits: ChatActivityLimits = {
  evaluationCooldownMs: 25_000, textCooldownMs: 90_000, reactionCooldownMs: 30_000,
  textPerWindow: 3, reactionsPerWindow: 5,
};

interface Job {
  limits: ChatActivityLimits;
  optional: boolean;
  expiresAt: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
interface Activity {
  lastEvaluation: number;
  text: number[];
  reaction: number[];
  continuation: number[];
  reservedContinuation: boolean;
  reservedText: number;
  reservedReaction: number;
}

// In-process coordination only. No delayed reply is created by cooldown
// expiry; optional opportunities must be refreshed by actual new events.
export class ChatScheduler {
  private readonly pending = new Map<string, Job[]>();
  private readonly running = new Set<string>();
  private readonly activity = new Map<string, Activity>();
  private readonly buffered = new Map<string, { timer: ReturnType<typeof setTimeout>; startedAt: number; job: () => void }>();
  private active = 0;
  private queued = 0;
  private closed = false;
  private readonly evaluations = new Map<string, number[]>();
  private readonly exchanges = new Map<string, { lastRelevantAt: number; replies: number; reserved: boolean; window: number[] }>();

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly concurrency = 4,
    private readonly maxPendingPerChannel = 12,
    private readonly maxPendingGlobal = 256,
  ) {}

  public run<T>(key: string, optional: boolean, limits: ChatActivityLimits, operation: () => Promise<T>, expiresAt = Infinity): Promise<T | null> {
    if (this.closed) return Promise.reject(new SocialOutputSuppressed());
    let queue = this.pending.get(key);
    if (!queue) { queue = []; this.pending.set(key, queue); }
    if (optional) {
      const replaced = queue.findIndex((job) => job.optional);
      if (replaced >= 0) { queue.splice(replaced, 1)[0]!.resolve(null); this.queued--; }
    }
    if (queue.length >= this.maxPendingPerChannel || this.queued >= this.maxPendingGlobal) {
      const disposable = queue.findIndex((job) => job.optional);
      if (!optional && disposable >= 0) { queue.splice(disposable, 1)[0]!.resolve(null); this.queued--; }
      else return optional ? Promise.resolve(null) : Promise.reject(new Error("Chat queue is full; try again shortly."));
    }
    return new Promise<T | null>((resolve, reject) => {
      queue.push({ optional, expiresAt, limits, resolve: resolve as (value: unknown) => void, reject,
        run: async () => {
          const activity = this.state(key);
          if (optional && !limits.continuation && this.now() - activity.lastEvaluation < limits.evaluationCooldownMs) return null;
          const guild = key.split(":")[0]!;
          const evaluations = this.evaluations.get(guild) ?? [];
          this.prune(evaluations);
          const cost = Math.max(1, Math.ceil(limits.optionalCallCost ?? 1));
          if (optional && evaluations.length + cost > (limits.optionalTurnsPerWindow ?? 100)) return null;
          if (optional) {
            if (!limits.continuation) activity.lastEvaluation = this.now();
            for (let index = 0; index < cost; index++) evaluations.push(this.now());
            this.evaluations.set(guild, evaluations);
          }
          return operation();
        },
      });
      this.queued++;
      this.pump();
    });
  }

  public recordModelAttempt(): void {
    // Provider usage logs track attempts. Admission is per optional turn,
    // never an exception in the middle of an accepted tool workflow.
  }

  public reserveOutput(key: string, kind: "text" | "reaction", limits: ChatActivityLimits, optional: boolean): ((success: boolean) => void) | null {
    if (!optional) return () => undefined;
    if (kind === "text" && limits.continuation) {
      const state = this.state(key); this.prune(state.continuation);
      const branchKey = `${key}:${limits.exchangeId ?? "channel"}`;
      if (this.exchanges.size >= 512 && !this.exchanges.has(branchKey)) {
        const idle = [...this.exchanges].find(([, exchange]) => !exchange.reserved);
        if (!idle) return null;
        this.exchanges.delete(idle[0]);
      }
      const exchange = this.exchanges.get(branchKey) ?? { lastRelevantAt: -Infinity, replies: 0, reserved: false, window: [] };
      if (this.now() - exchange.lastRelevantAt > 120_000) exchange.replies = 0;
      this.exchanges.set(branchKey, exchange);
      if (exchange.reserved || state.reservedContinuation || state.reservedText > 0 || exchange.replies >= (limits.continuationPerExchange ?? 10) ||
          state.continuation.length >= (limits.continuationPerWindow ?? 30) ||
          this.now() - Math.max(state.continuation.at(-1) ?? -Infinity, state.text.at(-1) ?? -Infinity) < (limits.continuationIntervalMs ?? 15_000)) return null;
      exchange.reserved = true; state.reservedContinuation = true;
      let finished = false;
      return (success) => { if (finished) return; finished = true; exchange.reserved = false; state.reservedContinuation = false;
        if (success) { exchange.replies++; exchange.lastRelevantAt = this.now(); state.continuation.push(this.now()); } };
    }
    const state = this.state(key);
    if (kind === "text" && (state.reservedContinuation || this.now() - (state.continuation.at(-1) ?? -Infinity) < limits.textCooldownMs)) return null;
    const values = state[kind];
    this.prune(values);
    const count = kind === "text" ? limits.textPerWindow : limits.reactionsPerWindow;
    const cooldown = kind === "text" ? limits.textCooldownMs : limits.reactionCooldownMs;
    const reserved = kind === "text" ? state.reservedText : state.reservedReaction;
    if (values.length + reserved >= count || reserved > 0 || this.now() - (values.at(-1) ?? -Infinity) < cooldown) return null;
    if (kind === "text") state.reservedText++; else state.reservedReaction++;
    let finished = false;
    return (success) => {
      if (finished) return;
      finished = true;
      if (kind === "text") state.reservedText--; else state.reservedReaction--;
      if (success) values.push(this.now());
    };
  }

  public outputAvailable(key: string, kind: "text" | "reaction", limits: ChatActivityLimits): boolean {
    const state = this.state(key);
    const values = state[kind]; this.prune(values);
    if (kind === "text" && (state.reservedContinuation || this.now() - (state.continuation.at(-1) ?? -Infinity) < limits.textCooldownMs)) return false;
    return (kind === "text" ? state.reservedText : state.reservedReaction) === 0 &&
      values.length < (kind === "text" ? limits.textPerWindow : limits.reactionsPerWindow) &&
      this.now() - (values.at(-1) ?? -Infinity) >= (kind === "text" ? limits.textCooldownMs : limits.reactionCooldownMs);
  }

  public evaluationDelayMs(key: string, limits: ChatActivityLimits): number {
    return Math.max(0, limits.evaluationCooldownMs - (this.now() - this.state(key).lastEvaluation));
  }

  public bufferOpportunity(key: string, job: () => void): void {
    if (this.closed || (!this.buffered.has(key) && this.buffered.size >= this.maxPendingGlobal)) return;
    const prior = this.buffered.get(key);
    if (prior) clearTimeout(prior.timer);
    const startedAt = prior?.startedAt ?? this.now();
    const delay = Math.max(0, Math.min(4_000, 10_000 - (this.now() - startedAt)));
    const timer = setTimeout(() => {
      const candidate = this.buffered.get(key);
      this.buffered.delete(key);
      if (candidate && !this.closed) candidate.job();
    }, delay);
    timer.unref?.();
    this.buffered.set(key, { timer, startedAt, job });
  }

  public cancelBufferedOpportunity(key: string): void {
    const buffered = this.buffered.get(key);
    if (buffered) clearTimeout(buffered.timer);
    this.buffered.delete(key);
  }

  public stop(): void {
    this.closed = true;
    for (const { timer } of this.buffered.values()) clearTimeout(timer);
    this.buffered.clear();
    for (const jobs of this.pending.values()) jobs.forEach((job) => job.reject(new SocialOutputSuppressed()));
    this.pending.clear(); this.queued = 0;
  }

  private state(key: string): Activity {
    let state = this.activity.get(key);
    if (!state) {
      // Opportunistic bounded cleanup of inactive channel counters.
      if (this.activity.size >= 512) {
        const idle = [...this.activity.keys()].find((id) => !this.running.has(id) && !this.pending.has(id) && !this.activity.get(id)!.reservedContinuation && this.activity.get(id)!.reservedText === 0 && this.activity.get(id)!.reservedReaction === 0);
        if (idle) this.activity.delete(idle);
      }
      state = { lastEvaluation: -Infinity, text: [], reaction: [], continuation: [], reservedContinuation: false, reservedText: 0, reservedReaction: 0 };
      this.activity.set(key, state);
    }
    return state;
  }

  private prune(values: number[]): void {
    while (values.length && values[0]! <= this.now() - 600_000) values.shift();
  }

  private pump(): void {
    if (this.closed) return;
    while (true) {
      const available = [...this.pending.entries()].filter(([key, jobs]) => {
        const guild = key.split(":")[0]!;
        const running = [...this.running].filter((id) => id.split(":")[0] === guild).length;
        return !this.running.has(key) && jobs.length && running < (jobs[0]!.limits.concurrency ?? this.concurrency);
      });
      const next = available.find(([, jobs]) => jobs.some((job) => !job.optional)) ?? available[0];
      if (!next) return;
      const [key, jobs] = next;
      const direct = jobs.findIndex((job) => !job.optional);
      const job = jobs.splice(direct >= 0 ? direct : 0, 1)[0]!;
      this.queued--;
      if (jobs.length === 0) this.pending.delete(key);
      if (this.now() >= job.expiresAt) { job.resolve(null); continue; }
      this.active++; this.running.add(key);
      void job.run().then(job.resolve, job.reject).finally(() => {
        this.active--; this.running.delete(key); this.pump();
      });
    }
  }
}
