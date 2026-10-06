import type { Texts } from "../../../application/i18n/texts.js";
import { abilityOf, type CheckTest, type Skill } from "../../../domain/campaign/character/character-sheet.js";

// A class as the table reads it. Adventures name a class by one identifier in
// every language edition ("fighter"); the name a player sees comes from the
// language's own text, and an unknown class shows as written.
export function classLabel(text: Texts, raw: string | null): string {
  if (raw === null || raw === "") return "";
  return (text.campaign.classes as Readonly<Record<string, string | undefined>>)[raw.toLowerCase()] ?? raw;
}

// Message keys cannot contain hyphens, so "sleight-of-hand" is "sleightOfHand".
export function skillKey(skill: Skill): keyof Texts["campaign"]["skill"] {
  return skill.replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase()) as keyof Texts["campaign"]["skill"];
}

// The English abbreviation sits next to the localized name, where players cross-check rules.
export function checkLabel(test: CheckTest, text: Texts): string {
  const ability = abilityOf(test);
  const name = test.kind === "skill" ? text.campaign.skill[skillKey(test.skill)] : text.campaign.ability[ability];
  return `${test.kind === "save" ? text.campaign.msg.saveLabel({ name }) : name} (${ability.toUpperCase()})`;
}
