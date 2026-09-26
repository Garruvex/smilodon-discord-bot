import type { SealedContent } from "./content-registry.js";
import type { HouseRules } from "./house-rules.js";

// What the engine reads for one campaign: its pinned content version plus
// its validated house-rule values.
export interface SealedRuleset {
  readonly content: SealedContent;
  readonly houseRules: HouseRules;
}
