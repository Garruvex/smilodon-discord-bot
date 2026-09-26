import type { CampaignCommandBus } from "./campaign-command-bus.js";
import type { CampaignKey, CampaignUnitOfWork } from "./ports/campaign-store.js";
import type { DmJobWorker } from "./workers/dm-job-worker.js";
import type { DeliveryWorker } from "./workers/delivery-worker.js";
import type { RollWorker, WorkerRunResult } from "./workers/roll-worker.js";
import type { TimerWorker } from "./workers/timer-worker.js";

export interface RuntimeLogger {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface CampaignRuntimeOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly bus: CampaignCommandBus;
  readonly rolls: RollWorker;
  readonly timers: TimerWorker;
  readonly dm: DmJobWorker;
  readonly delivery: DeliveryWorker;
  readonly logger: RuntimeLogger;
  // Names this process start, so the recovery pause commands are new for each
  // start and never mistaken for an earlier start's (they are idempotent per start).
  readonly bootId: string;
  readonly pollMilliseconds?: number;
}

export interface RecoveryReport {
  // Campaigns whose timers were paused for the organizer to resume.
  readonly paused: readonly CampaignKey[];
  // Campaigns that crashed between starting and opening their first round.
  readonly firstRoundsOpened: readonly CampaignKey[];
}

// Runs a campaign's background work in one process: dice, timers, the DM's
// model calls, and delivery to the table (code structure §5, Workers). One
// pass runs each in turn; passes never overlap, and work queued while one is
// running triggers another right after it.
export class CampaignRuntime {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;

  public constructor(private readonly options: CampaignRuntimeOptions) {}

  // Recovers after a restart, then polls until stopped.
  public async start(): Promise<RecoveryReport> {
    this.stopped = false;
    const report = await this.recover();
    this.schedule();
    return report;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  // Called after a commit that queued work, so it runs promptly.
  public kick(): void {
    if (this.stopped) return;
    if (this.running !== null) {
      this.again = true;
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pass(), 0);
  }

  // One pass of every worker; exposed so tests and the harness can drive it.
  public async runOnce(): Promise<void> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = this.work().finally(() => {
      this.running = null;
    });
    await this.running;
    if (this.again) {
      this.again = false;
      await this.runOnce();
    }
  }

  // After a restart no deadline may fire unattended (plan §5): timed
  // campaigns are paused until the organizer resumes them, and a campaign that
  // stopped before its first round gets it now.
  public async recover(): Promise<RecoveryReport> {
    const active = await this.options.unitOfWork.transaction((tx) => tx.listRecordsByLifecycle(["active"]));
    const paused: CampaignKey[] = [];
    const firstRoundsOpened: CampaignKey[] = [];
    for (const { record } of active) {
      const { key } = record;
      try {
        const stored = await this.options.unitOfWork.transaction((tx) => tx.loadCampaign(key));
        if (stored === undefined) continue;
        const { state } = stored;
        if (state.lastRoundNumber === 0 && state.round === null && state.encounter === null && state.status === "active") {
          await this.options.bus.execute(key, { kind: "openRound" }, { commandId: `start:${key.campaignId}`, actor: { kind: "system" } });
          firstRoundsOpened.push(key);
        }
        const timed = record.pacing.roundSeconds !== null || record.pacing.rollSeconds !== null || record.pacing.turnSeconds !== null;
        if (timed && state.pausedBy === null) {
          const outcome = await this.options.bus.execute(
            key,
            { kind: "pauseCampaign", reason: "recovery" },
            { commandId: `recover:${this.options.bootId}:${key.campaignId}`, actor: { kind: "system" } },
          );
          if (outcome.kind === "accepted") paused.push(key);
        }
      } catch (error) {
        this.options.logger.error({ err: error, guildId: key.guildId, campaignId: key.campaignId }, "Campaign recovery failed");
      }
    }
    return { paused, firstRoundsOpened };
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.pass(), this.options.pollMilliseconds ?? 1_000);
  }

  private async pass(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    try {
      await this.runOnce();
    } catch (error) {
      this.options.logger.error({ err: error }, "Campaign worker pass failed");
    }
    this.schedule();
  }

  private async work(): Promise<void> {
    const { rolls, timers, dm, delivery, logger } = this.options;
    // Rolls can chain (a hit asks for damage), so run until none are left.
    for (let index = 0; index < 50; index += 1) {
      if (this.report("roll", await rolls.runOnce(), logger).processed === 0) break;
    }
    this.report("timer", await timers.runOnce(), logger);
    this.report("dm", await dm.runOnce(), logger);
    // Model work queues rolls and deliveries of its own; settle them in the same pass.
    for (let index = 0; index < 50; index += 1) {
      if (this.report("roll", await rolls.runOnce(), logger).processed === 0) break;
    }
    this.report("delivery", await delivery.runOnce(), logger);
  }

  private report(worker: string, result: WorkerRunResult, logger: RuntimeLogger): WorkerRunResult {
    for (const failure of result.failed) logger.warn({ worker, jobId: failure.id, error: failure.error }, "Campaign job failed and will be retried");
    return result;
  }
}
