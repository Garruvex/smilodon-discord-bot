import type { DeliverySpec } from "../../../domain/campaign/engine/engine-request.js";
import type { CampaignKey } from "./campaign-store.js";

// Shows something the engine decided to the table: the "?" die, a result,
// narration, a turn card. The Discord adapter implements it; it reads the
// saved campaign to render, so a retry after a failure draws the same thing.
// Presenting must be safe to repeat: delivery is at-least-once. `deliveryId`
// is the queued item's ID, the same on every retry, so the adapter can make its
// sends recognizable and Discord can drop a message it already has.
export interface CampaignPresenter {
  present(key: CampaignKey, delivery: DeliverySpec, deliveryId?: string): Promise<void>;
}
