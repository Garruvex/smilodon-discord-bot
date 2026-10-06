import type { CharacterSheet } from "../character/character-sheet.js";
import type { ArmorDefinition } from "../rules/content-definitions.js";
import type { ContentId } from "../rules/content-id.js";
import type { SealedContent } from "../rules/content-registry.js";

// Which armor and shield a hero has on. The gear rules that need no fight.

// Armor and shields count only while worn; everything else carried counts.
export function isWorn(sheet: CharacterSheet, content: SealedContent, itemId: ContentId<"item">): boolean {
  const type = wearableType(content, itemId);
  if (type === null) return true;
  if (sheet.worn !== undefined) return sheet.worn.includes(itemId);
  // Nothing recorded yet: the first armor and the first shield carried are worn.
  return sheet.equipment.find((id) => wearableType(content, id) === type) === itemId;
}

export function wearableType(content: SealedContent, itemId: ContentId<"item">): "armor" | "shield" | null {
  const definition = content.find(itemId);
  return definition?.kind === "item" && (definition.itemType === "armor" || definition.itemType === "shield") ? definition.itemType : null;
}

// The worn armor, if any (at most one can be worn at a time).
function wornArmor(sheet: CharacterSheet, content: SealedContent): ArmorDefinition | null {
  const id = [...new Set(sheet.equipment)].find((itemId) => wearableType(content, itemId) === "armor" && isWorn(sheet, content, itemId));
  const definition = id === undefined ? undefined : content.find(id);
  return definition?.kind === "item" && definition.itemType === "armor" ? definition : null;
}

// SRD 5.1: some armor imposes disadvantage on Dexterity (Stealth) checks
// while worn (chain mail and heavier).
export function hasStealthDisadvantage(sheet: CharacterSheet, content: SealedContent): boolean {
  return wornArmor(sheet, content)?.stealthDisadvantage === true;
}

// SRD 5.1: armor worn below its Strength requirement costs the wearer 10
// feet of speed.
export function armorSpeedPenalty(sheet: CharacterSheet, content: SealedContent): number {
  const requirement = wornArmor(sheet, content)?.strengthRequirement ?? null;
  return requirement !== null && sheet.abilityScores.str < requirement ? 10 : 0;
}
