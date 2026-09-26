import type { CampaignLanguage } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { AdventureDocument } from "../adventures/adventure-document.js";
import type { AdventureCatalog } from "./dm-ports.js";

export interface AdventureSummary {
  readonly id: string;
  readonly version: string;
  readonly languages: readonly CampaignLanguage[];
  // The title in each language edition.
  readonly titles: Readonly<Partial<Record<CampaignLanguage, string>>>;
  // Preset heroes, in the order the lobby offers them.
  readonly heroes: readonly { readonly id: string; readonly name: string; readonly class: string }[];
}

// The adventures a campaign can be started from: the bundled default now,
// approved uploads later. It also serves the DM's lookups while a campaign runs.
export interface AdventureLibrary extends AdventureCatalog {
  list(): readonly AdventureSummary[];
  document(adventureId: string, language: CampaignLanguage): AdventureDocument | undefined;
}
