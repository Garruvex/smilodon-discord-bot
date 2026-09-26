import type { CampaignUnitOfWork, OutboxItem } from "../ports/campaign-store.js";
import type { CampaignPresenter } from "../ports/campaign-presenter.js";
import { defaultMaxAttempts, type WorkerRunResult } from "./roll-worker.js";

// Sends queued deliveries to the table, in the order the engine queued them.
// The gameplay result is already saved, so a failed send never causes another
// roll or another spend; it is retried later with a bound. When one delivery of
// a campaign fails, that campaign's later deliveries wait behind it so the
// table never sees results out of order; other campaigns are unaffected.
export class DeliveryWorker {
  public constructor(
    private readonly unitOfWork: CampaignUnitOfWork,
    private readonly presenter: CampaignPresenter,
    private readonly maxAttempts = defaultMaxAttempts,
  ) {}

  public async runOnce(): Promise<WorkerRunResult> {
    const items = await this.unitOfWork.transaction((tx) => tx.pendingOutbox("deliver"));
    const blocked = new Set<string>();
    const failed: { id: string; error: string }[] = [];
    let processed = 0;
    for (const item of items) {
      const campaign = `${item.key.guildId}:${item.key.campaignId}`;
      if (blocked.has(campaign)) continue;
      try {
        await this.deliver(item);
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ id: item.id, error: message });
        blocked.add(campaign);
        await this.unitOfWork.transaction((tx) => tx.failOutboxAttempt(item.id, message, this.maxAttempts));
      }
    }
    return { processed, failed };
  }

  private async deliver(item: OutboxItem): Promise<void> {
    if (item.request.kind !== "deliver") return;
    await this.presenter.present(item.key, item.request.delivery);
    await this.unitOfWork.transaction((tx) => tx.completeOutbox(item.id));
  }
}
