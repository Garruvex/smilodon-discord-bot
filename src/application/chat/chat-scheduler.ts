import { SocialOutputSuppressed } from "./message-origin-store.js";
import { randomUUID } from "node:crypto";
import { bindDiagnosticTask, emitChatDiagnostic, safeFailure, type ChatDiagnosticEvent, type DiagnosticLogger } from "../diagnostics/chat-diagnostics.js";

type QueueEvent = Extract<ChatDiagnosticEvent, { event: "chat.queue.changed" }>;
type QueueReporter = (action: QueueEvent["action"], reason: QueueEvent["reason"], failure?: ReturnType<typeof safeFailure>) => void;
type OpportunityEvent = Extract<ChatDiagnosticEvent, { event: "chat.opportunity.changed" }>;
export type OpportunityCancellationReason = "cancelled" | "addressed_request" | "privacy_changed" | "source_invalidated" | "capacity";
interface BufferedOpportunity {
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  opportunityId: string;
  job: () => void;
  report: (action: OpportunityEvent["action"], reason: OpportunityEvent["reason"], delayMs?: number, previousOpportunityId?: string) => void;
}

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
  report: QueueReporter;
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
  private readonly buffered = new Map<string, BufferedOpportunity>();
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
    private readonly logger: DiagnosticLogger | null = null,
  ) {}

  public run<T>(key: string, optional: boolean, limits: ChatActivityLimits, operation: () => Promise<T>, expiresAt = Infinity): Promise<T | null> {
    const jobId = randomUUID();
    const enqueuedAt = this.now();
    let admittedAt: number | null = null;
    let finished = false;
    const report: QueueReporter = bindDiagnosticTask((action, reason, failure) => {
      if (finished) return;
      if (action === "admitted") admittedAt = this.now();
      if (action !== "enqueued" && action !== "admitted") finished = true;
      emitChatDiagnostic(this.logger, { event: "chat.queue.changed", jobId, action, reason, optional,
        queueDepth: this.pending.get(key)?.length ?? 0, waitMs: Math.max(0, (admittedAt ?? this.now()) - enqueuedAt), ...failure });
    });
    if (this.closed) { report("cancelled", "scheduler_closed"); return Promise.reject(new SocialOutputSuppressed()); }
    let queue = this.pending.get(key);
    if (!queue) { queue = []; this.pending.set(key, queue); }
    if (optional) {
      const replaced = queue.findIndex((job) => job.optional);
      if (replaced >= 0) {
        const replacedJob = queue.splice(replaced, 1)[0]!;
        this.queued--; replacedJob.report("cancelled", "replaced_by_optional"); replacedJob.resolve(null);
      }
    }
    if (queue.length >= this.maxPendingPerChannel || this.queued >= this.maxPendingGlobal) {
      const disposable = queue.findIndex((job) => job.optional);
      if (!optional && disposable >= 0) {
        const displaced = queue.splice(disposable, 1)[0]!;
        this.queued--; displaced.report("cancelled", "preempted_by_direct"); displaced.resolve(null);
      } else {
        report("skipped", queue.length >= this.maxPendingPerChannel ? "channel_queue_full" : "global_queue_full");
        return optional ? Promise.resolve(null) : Promise.reject(new Error("Chat queue is full; try again shortly."));
      }
    }
    return new Promise<T | null>((resolve, reject) => {
      queue.push({ optional, expiresAt, limits, resolve: resolve as (value: unknown) => void, reject, report,
        run: bindDiagnosticTask(async () => {
          const activity = this.state(key);
          if (optional && !limits.continuation && this.now() - activity.lastEvaluation < limits.evaluationCooldownMs) {
            report("skipped", "evaluation_cooldown"); return null;
          }
          const guild = key.split(":")[0]!;
          const evaluations = this.evaluations.get(guild) ?? [];
          this.prune(evaluations);
          const cost = Math.max(1, Math.ceil(limits.optionalCallCost ?? 1));
          if (optional && evaluations.length + cost > (limits.optionalTurnsPerWindow ?? 100)) {
            report("skipped", "evaluation_budget"); return null;
          }
          if (optional) {
            if (!limits.continuation) activity.lastEvaluation = this.now();
            for (let index = 0; index < cost; index++) evaluations.push(this.now());
            this.evaluations.set(guild, evaluations);
          }
          return operation();
        }),
      });
      this.queued++;
      report("enqueued", "accepted");
      this.pump();
    });
  }

  public reserveOutput(key: string, kind: "text" | "reaction", limits: ChatActivityLimits, optional: boolean): ((success: boolean) => void) | null {
    type ReservationEvent = Extract<ChatDiagnosticEvent, { event: "chat.output.reservation" }>;
    const reservationId = randomUUID();
    const report = bindDiagnosticTask((status: ReservationEvent["status"], reason: ReservationEvent["reason"]) => {
      emitChatDiagnostic(this.logger, { event: "chat.output.reservation", reservationId, kind, optional,
        continuation: limits.continuation === true, status, reason });
    });
    const deny = (reason: ReservationEvent["reason"]): null => { report("denied", reason); return null; };
    const reserve = (reason: "direct" | "available", release: (success: boolean) => void): ((success: boolean) => void) => {
      report("reserved", reason);
      let finished = false;
      return (success) => {
        if (finished) return;
        finished = true;
        release(success);
        report(success ? "committed" : "released", success ? "delivered" : "not_delivered");
      };
    };
    if (!optional) return reserve("direct", () => undefined);
    if (kind === "text" && limits.continuation) {
      const state = this.state(key); this.prune(state.continuation);
      const branchKey = `${key}:${limits.exchangeId ?? "channel"}`;
      if (this.exchanges.size >= 512 && !this.exchanges.has(branchKey)) {
        const idle = [...this.exchanges].find(([, exchange]) => !exchange.reserved);
        if (!idle) return deny("capacity");
        this.exchanges.delete(idle[0]);
      }
      const exchange = this.exchanges.get(branchKey) ?? { lastRelevantAt: -Infinity, replies: 0, reserved: false, window: [] };
      if (this.now() - exchange.lastRelevantAt > 120_000) exchange.replies = 0;
      this.exchanges.set(branchKey, exchange);
      if (exchange.reserved || state.reservedContinuation || state.reservedText > 0) return deny("in_flight");
      if (exchange.replies >= (limits.continuationPerExchange ?? 10)) return deny("exchange_limit");
      if (state.continuation.length >= (limits.continuationPerWindow ?? 30)) return deny("channel_limit");
      if (this.now() - Math.max(state.continuation.at(-1) ?? -Infinity, state.text.at(-1) ?? -Infinity) < (limits.continuationIntervalMs ?? 15_000)) return deny("cooldown");
      exchange.reserved = true; state.reservedContinuation = true;
      return reserve("available", (success) => { exchange.reserved = false; state.reservedContinuation = false;
        if (success) { exchange.replies++; exchange.lastRelevantAt = this.now(); state.continuation.push(this.now()); } });
    }
    const state = this.state(key);
    if (kind === "text" && state.reservedContinuation) return deny("in_flight");
    if (kind === "text" && this.now() - (state.continuation.at(-1) ?? -Infinity) < limits.textCooldownMs) return deny("cooldown");
    const values = state[kind];
    this.prune(values);
    const count = kind === "text" ? limits.textPerWindow : limits.reactionsPerWindow;
    const cooldown = kind === "text" ? limits.textCooldownMs : limits.reactionCooldownMs;
    const reserved = kind === "text" ? state.reservedText : state.reservedReaction;
    if (reserved > 0) return deny("in_flight");
    if (values.length + reserved >= count) return deny("channel_limit");
    if (this.now() - (values.at(-1) ?? -Infinity) < cooldown) return deny("cooldown");
    if (kind === "text") state.reservedText++; else state.reservedReaction++;
    return reserve("available", (success) => {
      if (kind === "text") state.reservedText--; else state.reservedReaction--;
      if (success) values.push(this.now());
    });
  }

  public outputAvailable(key: string, kind: "text" | "reaction", limits: ChatActivityLimits): boolean {
    const state = this.state(key);
    if (kind === "text" && limits.continuation) {
      this.prune(state.continuation);
      const exchange = this.exchanges.get(`${key}:${limits.exchangeId ?? "channel"}`);
      const replies = exchange && this.now() - exchange.lastRelevantAt <= 120000 ? exchange.replies : 0;
      return !state.reservedContinuation && state.reservedText === 0 && !exchange?.reserved &&
        replies < (limits.continuationPerExchange ?? 10) && state.continuation.length < (limits.continuationPerWindow ?? 30) &&
        this.now() - Math.max(state.continuation.at(-1) ?? -Infinity, state.text.at(-1) ?? -Infinity) >= (limits.continuationIntervalMs ?? 15000);
    }
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
    const opportunityId = randomUUID();
    let finished = false;
    const report: BufferedOpportunity["report"] = bindDiagnosticTask((action, reason, delayMs = 0, previousOpportunityId) => {
      if (finished) return;
      if (action === "cancelled" || action === "flushed" || action === "rejected") finished = true;
      emitChatDiagnostic(this.logger, { event: "chat.opportunity.changed", opportunityId, action, reason, delayMs,
        ...(previousOpportunityId ? { previousOpportunityId } : {}) });
    });
    if (this.closed || (!this.buffered.has(key) && this.buffered.size >= this.maxPendingGlobal)) {
      report("rejected", this.closed ? "scheduler_closed" : "capacity"); return;
    }
    const prior = this.buffered.get(key);
    if (prior) { clearTimeout(prior.timer); prior.report("cancelled", "superseded"); }
    const startedAt = prior?.startedAt ?? this.now();
    const delay = Math.max(0, Math.min(4_000, 10_000 - (this.now() - startedAt)));
    const timer = setTimeout(() => {
      const candidate = this.buffered.get(key);
      this.buffered.delete(key);
      if (candidate && !this.closed) { candidate.report("flushed", "ready"); candidate.job(); }
    }, delay);
    timer.unref?.();
    this.buffered.set(key, { timer, startedAt, opportunityId, report, job: bindDiagnosticTask(job) });
    report(prior ? "coalesced" : "buffered", "coalescing", delay, prior?.opportunityId);
  }

  public cancelBufferedOpportunity(key: string, reason: OpportunityCancellationReason = "cancelled"): void {
    const buffered = this.buffered.get(key);
    if (buffered) { clearTimeout(buffered.timer); buffered.report("cancelled", reason); }
    this.buffered.delete(key);
  }

  public stop(): void {
    this.closed = true;
    for (const opportunity of this.buffered.values()) { clearTimeout(opportunity.timer); opportunity.report("cancelled", "shutdown"); }
    this.buffered.clear();
    for (const jobs of this.pending.values()) jobs.forEach((job) => { job.report("cancelled", "shutdown"); job.reject(new SocialOutputSuppressed()); });
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
      if (this.now() >= job.expiresAt) { job.report("cancelled", "expired"); job.resolve(null); continue; }
      this.active++; this.running.add(key);
      job.report("admitted", "accepted");
      void job.run().then((result) => { job.report("completed", "executed"); job.resolve(result); }, (error: unknown) => {
        if (error instanceof SocialOutputSuppressed) job.report("cancelled", "operation_suppressed");
        else job.report("failed", "operation_failed", safeFailure(error, "operation_error"));
        job.reject(error);
      }).finally(() => {
        this.active--; this.running.delete(key); this.pump();
      });
    }
  }
}
