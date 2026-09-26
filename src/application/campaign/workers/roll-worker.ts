import { rollD20Test } from "../../../domain/campaign/dice/d20-test.js";
import type { RandomSource } from "../../../domain/campaign/dice/random-source.js";
import type { CampaignCommandBus } from "../campaign-command-bus.js";
import type { CampaignUnitOfWork, OutboxItem, SavedRoll } from "../ports/campaign-store.js";
import type { Clock } from "../ports/clock.js";

export interface WorkerRunResult {
  readonly processed: number;
  readonly failed: readonly { readonly id: string; readonly error: string }[];
}

export const defaultMaxAttempts = 5;

// Rolls requested dice exactly once. The result is saved before the engine
// sees it, so a crash or retry at any point re-delivers the same saved dice
// and never rolls again.
export class RollWorker {
  public constructor(
    private readonly unitOfWork: CampaignUnitOfWork,
    private readonly bus: CampaignCommandBus,
    private readonly random: RandomSource,
    private readonly clock: Clock,
    private readonly maxAttempts = defaultMaxAttempts,
  ) {}

  public async runOnce(): Promise<WorkerRunResult> {
    const items = await this.unitOfWork.transaction((tx) => tx.pendingOutbox("roll"));
    const failed: { id: string; error: string }[] = [];
    for (const item of items) {
      try {
        await this.process(item);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ id: item.id, error: message });
        await this.unitOfWork.transaction((tx) => tx.failOutboxAttempt(item.id, message, this.maxAttempts));
      }
    }
    return { processed: items.length - failed.length, failed };
  }

  private async process(item: OutboxItem): Promise<void> {
    const request = item.request;
    if (request.kind !== "roll") return;
    const saved = await this.unitOfWork.transaction(async (tx): Promise<SavedRoll> => {
      const existing = await tx.findRoll(item.key, request.rollId);
      if (existing !== undefined) return existing;
      return tx.saveRoll({
        key: item.key,
        rollId: request.rollId,
        roll: rollD20Test(request.spec, this.random),
        rolledAt: this.clock.now(),
      });
    });
    const outcome = await this.bus.execute(
      item.key,
      { kind: "recordRoll", rollId: request.rollId, roll: saved.roll },
      { commandId: `record-roll:${request.rollId}`, actor: { kind: "system" } },
    );
    if (outcome.kind === "rejected") {
      throw new Error(`Roll ${request.rollId} was rejected: ${outcome.rejection.code}.`);
    }
    await this.unitOfWork.transaction((tx) => tx.completeOutbox(item.id));
  }
}
