import { SocialOutputSuppressed } from "./message-origin-store.js";

export interface ChatActivityLimits {
  evaluationCooldownMs: number;
  textCooldownMs: number;
  reactionCooldownMs: number;
  textPerWindow: number;
  reactionsPerWindow: number;
  concurrency?: number;
  optionalTurnsPerWindow?: number;
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
          if (optional && this.now() - activity.lastEvaluation < limits.evaluationCooldownMs) return null;
          const guild = key.split(":")[0]!;
          const evaluations = this.evaluations.get(guild) ?? [];
          this.prune(evaluations);
          if (optional && evaluations.length >= (limits.optionalTurnsPerWindow ?? 100)) return null;
          if (optional) {
            activity.lastEvaluation = this.now(); evaluations.push(this.now());
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
    const state = this.state(key);
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
        const idle = [...this.activity.keys()].find((id) => !this.running.has(id) && !this.pending.has(id));
        if (idle) this.activity.delete(idle);
      }
      state = { lastEvaluation: -Infinity, text: [], reaction: [], reservedText: 0, reservedReaction: 0 };
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
