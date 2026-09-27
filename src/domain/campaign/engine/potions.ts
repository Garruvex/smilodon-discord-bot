import type { CharacterSheet } from "../character/character-sheet.js";
import type { CharacterId } from "../core/ids.js";
import type { PotionDefinition } from "../rules/content-definitions.js";
import type { ContentId } from "../rules/content-id.js";
import type { SealedContent } from "../rules/content-registry.js";
import type { CampaignState } from "../state/campaign-state.js";

// The potion definition when the hero holds this item and it is a potion.
export function potionOf(sheet: CharacterSheet | undefined, content: SealedContent, itemId: ContentId<"item">): PotionDefinition | null {
  if (sheet?.equipment.includes(itemId) !== true) return null;
  const definition = content.find(itemId);
  return definition?.kind === "item" && definition.itemType === "potion" ? definition : null;
}

export function potionFor(state: CampaignState, content: SealedContent, characterId: CharacterId, itemId: ContentId<"item">): PotionDefinition | null {
  return potionOf(state.characters[characterId], content, itemId);
}
