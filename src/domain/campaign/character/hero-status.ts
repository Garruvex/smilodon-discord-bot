import type { SealedContent } from "../rules/content-registry.js";
import type { CharacterSheet } from "./character-sheet.js";

// What a hero carries between and into fights: hit points, spell slots and limited
// feature uses left. It belongs to the hero, not to any one fight.

export interface HeroResources {
  // Remaining slots per slot level.
  readonly spellSlots: Readonly<Record<number, number>>;
  // Remaining uses per limited feature.
  readonly featureUses: Readonly<Record<string, number>>;
}

// What a hero brings into a fight from outside it.
export interface HeroStatus {
  readonly hp: number;
  readonly resources: HeroResources;
  // Unspent Hit Dice; absent means all of them (the hero's level).
  readonly hitDice?: number;
  // Died in a fight; never rejoins one.
  readonly dead?: boolean;
}

// A rested hero: every slot and every limited feature use.
export function defaultHeroResources(sheet: CharacterSheet, content: SealedContent): HeroResources {
  const featureUses: Record<string, number> = {};
  for (const id of sheet.features) {
    const feature = content.find(id);
    if (feature?.kind === "feature" && feature.action !== null) featureUses[id] = feature.action.uses.count;
  }
  return { spellSlots: { ...(sheet.spellcasting?.slots ?? {}) }, featureUses };
}
