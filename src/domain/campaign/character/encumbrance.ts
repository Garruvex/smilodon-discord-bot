import { srdItemWeights } from "../rules/srd-item-weights.generated.js";
import type { CharacterSheet } from "./character-sheet.js";

// The SRD's carrying rules. A creature carries up to 15 pounds for each point of Strength; the variant rule slows a hero
// carrying more than 5 (encumbered, -10 feet) or 10 (heavily encumbered, -20 feet and disadvantage on physical rolls) per point.
export type LoadBand = "light" | "encumbered" | "heavy" | "over";

export interface Load {
  readonly carried: number;
  readonly capacity: number;
  readonly band: LoadBand;
  // The feet of speed the variant rule takes away.
  readonly speedPenalty: number;
}

export function carryingCapacity(strength: number): number {
  return strength * 15;
}

// Pounds of equipment carried (coins and anything the SRD gives no weight are not counted).
export function carriedWeight(sheet: CharacterSheet): number {
  return sheet.equipment.reduce((sum, id) => sum + (srdItemWeights[id] ?? 0), 0);
}

export function loadOf(sheet: CharacterSheet): Load {
  const carried = carriedWeight(sheet);
  const strength = sheet.abilityScores.str;
  const capacity = carryingCapacity(strength);
  if (carried > capacity) return { carried, capacity, band: "over", speedPenalty: 20 };
  if (carried > strength * 10) return { carried, capacity, band: "heavy", speedPenalty: 20 };
  if (carried > strength * 5) return { carried, capacity, band: "encumbered", speedPenalty: 10 };
  return { carried, capacity, band: "light", speedPenalty: 0 };
}
