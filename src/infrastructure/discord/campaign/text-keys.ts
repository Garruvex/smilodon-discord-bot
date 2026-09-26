import type { Texts } from "../../../application/i18n/texts.js";
import type { Skill } from "../../../domain/campaign/character/character-sheet.js";

// Message keys cannot contain hyphens, so "sleight-of-hand" is "sleightOfHand".
export function skillKey(skill: Skill): keyof Texts["campaign"]["skill"] {
  return skill.replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase()) as keyof Texts["campaign"]["skill"];
}
