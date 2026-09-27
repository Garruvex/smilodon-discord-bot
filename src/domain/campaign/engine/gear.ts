import type { CharacterSheet } from "../character/character-sheet.js";
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
