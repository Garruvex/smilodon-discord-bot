import type { CampaignKey, CampaignUnitOfWork, OutboxItem } from "../ports/campaign-store.js";
import type { CampaignPresenter } from "../ports/campaign-presenter.js";
import type { Clock } from "../ports/clock.js";
import { type WorkerRunResult } from "./roll-worker.js";

// Waits between attempts (milliseconds), then the last one repeats: a Discord
// hiccup is retried within seconds, an outage every five minutes.
export const deliveryBackoff: readonly number[] = [5_000, 15_000, 45_000, 120_000, 300_000];
// About half an hour of trying before the delivery is given up on and the
// organizer is told (Repair puts it back).
export const deliveryMaxAttempts = 10;

export interface DeliveryWorkerOptions {
  readonly maxAttempts?: number;
  // Without a clock a failed delivery is retried on the next pass.
  readonly clock?: Clock;
  // A delivery that used all its attempts.
  readonly onAbandoned?: (key: CampaignKey, item: OutboxItem, error: string) => Promise<void> | void;
}

// Sends queued deliveries to the table, in the order the engine queued them.
// The gameplay result is already saved, so a failed send never causes another
// roll or another spend; it is retried later with a bound. When one delivery of
// a campaign fails, that campaign's later deliveries wait behind it so the
// table never sees results out of order; other campaigns are unaffected.
export class DeliveryWorker {
  public constructor(
    private readonly unitOfWork: CampaignUnitOfWork,
    private readonly presenter: CampaignPresenter,
    private readonly options: DeliveryWorkerOptions = {},
  ) {}

  public async runOnce(): Promise<WorkerRunResult> {
    const items = await this.unitOfWork.transaction((tx) => tx.pendingOutbox("deliver"));
    const maxAttempts = this.options.maxAttempts ?? deliveryMaxAttempts;
    const now = this.options.clock?.now() ?? 0;
    const blocked = new Set<string>();
    const failed: { id: string; error: string }[] = [];
    let processed = 0;
    for (const item of items) {
      const campaign = `${item.key.guildId}:${item.key.campaignId}`;
      if (blocked.has(campaign)) continue;
      // A delivery waiting out its backoff holds back the ones after it.
      if (item.notBefore > now) {
        blocked.add(campaign);
        continue;
      }
      try {
        await this.deliver(item);
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ id: item.id, error: message });
        blocked.add(campaign);
        const wait = deliveryBackoff[Math.min(item.attempts, deliveryBackoff.length - 1)] ?? 0;
        const retryAt = this.options.clock === undefined ? 0 : now + wait;
        await this.unitOfWork.transaction((tx) => tx.failOutboxAttempt(item.id, message, maxAttempts, retryAt));
        if (item.attempts + 1 >= maxAttempts) await this.options.onAbandoned?.(item.key, item, message);
      }
    }
    return { processed, failed };
  }

  private async deliver(item: OutboxItem): Promise<void> {
    if (item.request.kind !== "deliver") return;
    await this.presenter.present(item.key, item.request.delivery, item.id);
    await this.unitOfWork.transaction((tx) => tx.completeOutbox(item.id));
  }
}
