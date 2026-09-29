import type { ClassDefinition } from "../rules/content-definitions.js";
import type { SealedContent } from "../rules/content-registry.js";
import type { ContentId } from "../rules/content-id.js";
import type { CharacterSheet } from "./character-sheet.js";
import { classLevelsOf } from "./character-build.js";
import { spellSlotsForLevel } from "./leveling.js";

// The spells a hero may cast: the ones on their sheet, and every spell on the
// spell list of each caster class they hold whose level their slots in that class
// reach. Simplified: a hero has their whole class list at hand, with no separate
// "prepared" or "known" cap, so no spell-choice screen is needed.
export function spellbookOf(sheet: Pick<CharacterSheet, "spellcasting" | "className" | "level" | "classLevels">, content: SealedContent): readonly ContentId<"spell">[] {
  if (sheet.spellcasting === null) return [];
  const book = new Set<ContentId<"spell">>(sheet.spellcasting.spells);
  for (const [className, level] of Object.entries(classLevelsOf(sheet))) {
    const definition = content.find(`class:${className}`);
    if (definition?.kind !== "class" || level === undefined || level < 1) continue;
    const highest = highestSpellLevel(definition, level);
    for (const id of definition.spellList ?? []) {
      const spell = content.find(id);
      if (spell?.kind === "spell" && spell.level <= highest) book.add(id);
    }
  }
  return [...book];
}

// Cantrips always; leveled spells up to the highest slot the class alone grants at this level.
function highestSpellLevel(definition: ClassDefinition, level: number): number {
  const slots = Object.keys(spellSlotsForLevel(definition.casterType, level)).map(Number);
  return Math.max(0, ...slots);
}
