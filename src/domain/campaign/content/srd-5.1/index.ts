import type { ContentDefinition } from "../../rules/content-definitions.js";
import { ContentRegistryBuilder, type ContentBuildOptions, type SealedContent } from "../../rules/content-registry.js";
import { srd51Conditions } from "./conditions.js";
import { srd51Weapons } from "./items/weapons.js";
import { srd51StarterMonsters } from "./monsters/starter-monsters.js";
import { srd51Cantrips } from "./spells/cantrips.js";
import { srd51Level1Spells } from "./spells/level-1.js";

export const srd51RulesetId = "srd-5.1";
// Bump when any shipped definition changes behavior; campaigns pin a version.
export const srd51Version = "2026.1";

export const srd51Content: readonly ContentDefinition[] = [
  ...srd51Conditions,
  ...srd51Cantrips,
  ...srd51Level1Spells,
  ...srd51Weapons,
  ...srd51StarterMonsters,
];

export function buildSrd51(options: ContentBuildOptions): SealedContent {
  return new ContentRegistryBuilder(srd51RulesetId, srd51Version).add(srd51Content).build(options);
}
