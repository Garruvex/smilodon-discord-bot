import { definePotion, type ItemDefinition } from "../../../rules/content-definitions.js";

// SRD 5.1, Equipment: Potion of healing (2d4 + 2, taken as its average).
export const potionOfHealing = definePotion({ id: "item:potion-of-healing", source: "SRD 5.1", healing: 7 });

export const srd51Potions: readonly ItemDefinition[] = [potionOfHealing];
