import type { HeroView } from "../../../application/campaign/views/campaign-views.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { skills as allSkills, type CharacterSheet, type Skill } from "../../../domain/campaign/character/character-sheet.js";
import { skillKey } from "./text-keys.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";

// A hero's public sheet as private text (panel spec, Details): identity, HP
// and defense, ability scores, proficient skills, gear, features, and spells.
// Class, item, feature, and spell names are in the campaign language; the
// English abbreviations sit beside stats where players cross-check rules.
export function renderHeroSheet(sheet: CharacterSheet, view: HeroView, text: Texts, glossary: Glossary): string {
  const t = text.campaign;
  const name = (id: string): string => glossary.names[id] ?? id;
  const none = t.sheet.none;
  const scores = sheet.abilityScores;
  const skillLine = allSkills
    .flatMap((skill: Skill) => {
      const proficiency = sheet.skills[skill];
      if (proficiency === undefined) return [];
      const label = t.skill[skillKey(skill)];
      return [proficiency === "expertise" ? t.sheet.expertise({ skill: label }) : label];
    })
    .join(", ");
  return [
    `**${t.sheet.title({ name: sheet.name, class: sheet.className ?? "", level: sheet.level })}**`,
    t.sheet.vitals({ hp: Math.max(0, view.hp), max: view.maxHp, ac: view.armorClass, speed: sheet.speed }),
    t.sheet.abilities({ str: scores.str, dex: scores.dex, con: scores.con, int: scores.int, wis: scores.wis, cha: scores.cha }),
    t.sheet.skills({ skills: skillLine === "" ? none : skillLine }),
    t.sheet.equipment({ items: sheet.equipment.length === 0 ? none : sheet.equipment.map(name).join(", ") }),
    t.sheet.features({ features: sheet.features.length === 0 ? none : sheet.features.map(name).join(", ") }),
    ...(sheet.spellcasting === null ? [] : [t.sheet.spells({ spells: sheet.spellcasting.spells.map(name).join(", ") })]),
  ].join("\n");
}

