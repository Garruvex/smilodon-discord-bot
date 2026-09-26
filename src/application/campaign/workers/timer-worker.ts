import type { CampaignCommand } from "../../../domain/campaign/commands/campaign-command.js";
import { assertNever } from "../../../domain/campaign/core/assert-never.js";
import type { TimerSpec } from "../../../domain/campaign/engine/engine-request.js";
import type { CampaignCommandBus } from "../campaign-command-bus.js";
import type { CampaignUnitOfWork } from "../ports/campaign-store.js";
import type { Clock } from "../ports/clock.js";
import type { WorkerRunResult } from "./roll-worker.js";

// Fires due timers as commands. A timer that races a player's response is
// settled by the engine: whichever command commits first wins, and the other
// finds nothing to do. Each firing has a stable command ID, so a crash
// between firing and marking it fired cannot fire it twice.
export class TimerWorker {
  public constructor(
    private readonly unitOfWork: CampaignUnitOfWork,
    private readonly bus: CampaignCommandBus,
    private readonly clock: Clock,
  ) {}

  public async runOnce(): Promise<WorkerRunResult> {
    const due = await this.unitOfWork.transaction((tx) => tx.dueTimers(this.clock.now()));
    const failed: { id: string; error: string }[] = [];
    for (const record of due) {
      const { timer } = record;
      try {
        await this.bus.execute(record.key, commandFor(timer), {
          commandId: `timer:${timer.timerId}@${timer.dueAt}`,
          actor: { kind: "system" },
        });
        await this.unitOfWork.transaction((tx) => tx.markTimerFired(record.key, timer.timerId));
      } catch (error) {
        // Left pending: the next run retries with the same command ID.
        failed.push({ id: timer.timerId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { processed: due.length - failed.length, failed };
  }
}

function commandFor(timer: TimerSpec): CampaignCommand {
  switch (timer.kind) {
    case "roundWindow":
      return { kind: "roundTimerExpired", roundNumber: timer.roundNumber };
    case "roll":
      return { kind: "rollTimerExpired", checkId: timer.checkId };
    case "combatTurn":
      return { kind: "turnTimerExpired", encounterId: timer.encounterId, turnNumber: timer.turnNumber };
    default:
      return assertNever(timer);
  }
}
