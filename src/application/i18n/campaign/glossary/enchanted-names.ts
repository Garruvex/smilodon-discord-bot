import { enchantedGearList } from "../../../../domain/campaign/content/srd-5.1/items/magic-gear.js";
import { spellScrollList } from "../../../../domain/campaign/content/srd-5.1/items/spell-scrolls.js";

// Names for the +1 to +3 versions of every ordinary weapon, armor and shield: the base item's name and its bonus.
export function enchantedNames(names: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(enchantedGearList.flatMap(({ id, baseId, bonus }) => (names[baseId] === undefined ? [] : [[id, `${names[baseId]} +${bonus}`] as const])));
}

// Names for the scroll of every spell: the spell's name, with the word for a scroll.
export function scrollNames(names: Readonly<Record<string, string>>, format: (spell: string) => string): Readonly<Record<string, string>> {
  return Object.fromEntries(spellScrollList.flatMap(({ id, spellId }) => (names[spellId] === undefined ? [] : [[id, format(names[spellId])] as const])));
}
