import type { CampaignKey } from "./campaign-store.js";

// Asks for a campaign's cards (lobby, party, adventure panel) to be redrawn
// from saved state. Fire and forget: the implementation coalesces bursts and
// retries, and a failed redraw never affects the game.
export interface CardRefresher {
  refresh(key: CampaignKey): void;
}
