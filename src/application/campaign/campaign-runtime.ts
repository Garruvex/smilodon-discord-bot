import type { CampaignState } from "../../domain/campaign/state/campaign-state.js";
import type { CampaignCommandBus } from "./campaign-command-bus.js";
import type { CampaignKey, CampaignUnitOfWork } from "./ports/campaign-store.js";
import type { DmJobWorker } from "./workers/dm-job-worker.js";
import type { DeliveryWorker } from "./workers/delivery-worker.js";
import type { RollWorker, WorkerRunResult } from "./workers/roll-worker.js";
import type { TimerWorker } from "./workers/timer-worker.js";
import type { ImageWorker } from "./workers/image-worker.js";

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
  // Admits approved players who selected a character while an encounter ran.
  readonly queuedJoins?: { runOnce(): Promise<{ readonly processed: number; readonly failed: readonly { readonly id: string; readonly error: string }[] }> };
  // Scene pictures, when an image model is set up.
  readonly images?: ImageWorker;
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
  // Campaigns left with no round after a quiet one (before quiet rounds opened
  // the next round by themselves); each gets its round now.
  readonly roundsReopened: readonly CampaignKey[];
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
  // Pictures take a long time, so they run beside the game's work, never inside it.
  private pictures: Promise<void> | null = null;

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
    await this.pictures;
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
    const roundsReopened: CampaignKey[] = [];
    for (const { record } of active) {
      const { key } = record;
      try {
        const stored = await this.options.unitOfWork.transaction((tx) => tx.loadCampaign(key));
        if (stored === undefined) continue;
        const { state } = stored;
        if (state.lastRoundNumber === 0 && state.round === null && state.encounter === null && state.status === "active" && state.opening === undefined) {
          await this.options.bus.execute(key, { kind: "beginAdventure" }, { commandId: `start:${key.campaignId}`, actor: { kind: "system" } });
          firstRoundsOpened.push(key);
        }
        if (await this.endedOnQuietRound(key, state)) {
          await this.options.bus.execute(key, { kind: "openRound" }, { commandId: `reopen:${this.options.bootId}:${key.campaignId}`, actor: { kind: "system" } });
          roundsReopened.push(key);
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
    return { paused, firstRoundsOpened, roundsReopened };
  }

  // A game whose last round was quiet and never got another: nothing is
  // pending that would open one.
  private async endedOnQuietRound(key: CampaignKey, state: CampaignState): Promise<boolean> {
    if (state.lastRoundNumber === 0 || state.round !== null || state.status !== "active" || state.pausedBy !== null) return false;
    if (state.pendingEncounter !== null || (state.encounter !== null && state.encounter.status !== "ended")) return false;
    const events = await this.options.unitOfWork.transaction((tx) => tx.readEvents(key));
    const last = events.map((envelope) => envelope.event).findLast((event) => event.kind === "roundResolved");
    return last?.kind === "roundResolved" && last.quiet && last.roundNumber === state.lastRoundNumber;
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
    const { rolls, timers, dm, delivery, queuedJoins, logger } = this.options;
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
    if (queuedJoins !== undefined) this.report("queued-join", await queuedJoins.runOnce(), logger);
    this.startPictures();
  }

  // One picture run at a time, started here and not awaited: dice, timers and
  // narration for every campaign carry on while the image model works.
  private startPictures(): void {
    const { images, logger } = this.options;
    if (images === undefined || this.pictures !== null || this.stopped) return;
    this.pictures = images
      .runOnce()
      .then((result) => void this.report("image", result, logger))
      .catch((error: unknown) => logger.error({ err: error }, "Scene picture pass failed"))
      .finally(() => {
        this.pictures = null;
      });
  }

  // Waits for the picture run in flight; for tests and the harness.
  public async settlePictures(): Promise<void> {
    await this.pictures;
  }

  private report(worker: string, result: WorkerRunResult, logger: RuntimeLogger): WorkerRunResult {
    for (const failure of result.failed) logger.warn({ worker, jobId: failure.id, error: failure.error }, "Campaign job failed and will be retried");
    return result;
  }
}
