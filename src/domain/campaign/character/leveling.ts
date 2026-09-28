import type { Ability } from "../rules/effects.js";
import type { CasterType } from "../rules/content-definitions.js";
import type { Skill } from "../rules/skills.js";
import { abilityModifier, type CharacterSheet } from "./character-sheet.js";
import { classLevelsOf, classTemplates, type BuildClass } from "./character-build.js";

// XP and levels on top of the class roster (character-build.ts): the
// roster stops at what a level-1 hero has; this is what changes as they earn
// XP. Numbers only — hit points, proficiency bonus, spell slots, and ability
// score improvements all follow the SRD tables below, so a new level needs no
// hand-authored content, apart from the class features at levels 2, 3 and 5
// (features/higher-level-features.ts), granted the same way. Extra Attack
// (level 5, Fighter/Barbarian/Paladin/Ranger/Monk) is mechanical; the rest
// are narrative. Other mechanical level 2+ features (Wild Shape, Divine
// Smite, Cunning Action, Sneak Attack's scaling, subclass choices) stay out
// of scope.

export const maxLevel = 20;

// SRD 5.1, Character Advancement: total XP needed to reach each level.
// Index 0 is level 1.
export const xpThresholds: readonly number[] = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
];

export function levelForXp(xp: number): number {
  let level = 1;
  for (let index = 1; index < xpThresholds.length; index += 1) {
    if (xp < (xpThresholds[index] ?? Infinity)) break;
    level = index + 1;
  }
  return Math.min(level, maxLevel);
}

export function xpForNextLevel(level: number): number | null {
  return level >= maxLevel ? null : (xpThresholds[level] ?? null);
}

// SRD 5.1: +2 through level 4, then +1 every four levels.
export function proficiencyBonusForLevel(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

// The hero's Hit Die, taken at every level (not rolled): SRD 5.1's fixed
// "take the average" rule, already used for Second Wind and potions.
export function hpGainForLevel(hitDie: 6 | 8 | 10 | 12, constitutionScore: number): number {
  return Math.floor(hitDie / 2) + 1 + abilityModifier(constitutionScore);
}

// Ability Score Improvements land at these levels (SRD 5.1; ignores the
// subclass features, such as Fighter's extra ASIs, that milestone 0 content
// doesn't implement).
export const asiLevels: readonly number[] = [4, 8, 12, 16, 19];

// +2 to one ability, or +1 to two: the default puts the class's two most
// relied-on abilities first (character-build.ts's "suggested" order),
// splitting the +2 between them when both have room, capped at 20.
export function defaultAsiAllocation(buildClass: BuildClass, abilityScores: Readonly<Record<Ability, number>>): Readonly<Record<Ability, number>> {
  const order = classTemplates[buildClass].suggested;
  const result: Record<Ability, number> = { ...abilityScores };
  let remaining = 2;
  for (const ability of order) {
    if (remaining <= 0) break;
    if (result[ability] >= 20) continue;
    result[ability] += 1;
    remaining -= 1;
  }
  return result;
}

// Caster type, spellcasting ability, and the first spells a class ever
// knows are all part of its content now (content/srd-5.1/classes.ts),
// alongside its level-1 template; casterTypeOf is kept as a thin accessor
// since it reads better at call sites than classTemplates[x].casterType.
export function casterTypeOf(buildClass: BuildClass): CasterType {
  return classTemplates[buildClass].casterType;
}

// SRD 5.1 multiclass spell slot tables, by character level (index 0 = level 1).
const fullCasterSlots: readonly Readonly<Record<number, number>>[] = [
  { 1: 2 },
  { 1: 3 },
  { 1: 4, 2: 2 },
  { 1: 4, 2: 3 },
  { 1: 4, 2: 3, 3: 2 },
  { 1: 4, 2: 3, 3: 3 },
  { 1: 4, 2: 3, 3: 3, 4: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 2 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 1, 7: 1, 8: 1, 9: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 1, 8: 1, 9: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 2, 8: 1, 9: 1 },
];

const halfCasterSlots: readonly Readonly<Record<number, number>>[] = [
  {},
  { 1: 2 },
  { 1: 3 },
  { 1: 3 },
  { 1: 4, 2: 2 },
  { 1: 4, 2: 2 },
  { 1: 4, 2: 3 },
  { 1: 4, 2: 3 },
  { 1: 4, 2: 3, 3: 2 },
  { 1: 4, 2: 3, 3: 2 },
  { 1: 4, 2: 3, 3: 3 },
  { 1: 4, 2: 3, 3: 3 },
  { 1: 4, 2: 3, 3: 3, 4: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 2 },
  { 1: 4, 2: 3, 3: 3, 4: 2 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
];

// Pact Magic: one slot level active at a time, its level rising with the
// warlock's own level, the count rising separately.
const pactSlotLevel: readonly number[] = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
const pactSlotCount: readonly number[] = [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4];

export function spellSlotsForLevel(casterType: CasterType, level: number): Readonly<Record<number, number>> {
  const index = Math.min(Math.max(level, 1), maxLevel) - 1;
  switch (casterType) {
    case "full":
      return fullCasterSlots[index] ?? {};
    case "half":
      return halfCasterSlots[index] ?? {};
    case "pact": {
      const slotLevel = pactSlotLevel[index] ?? 1;
      const count = pactSlotCount[index] ?? 1;
      return { [slotLevel]: count };
    }
    case "none":
      return {};
    default:
      return {};
  }
}

// A spell ID, named off Spellcasting's own shape so this file needs no
// direct import of ContentId just to type a Set of them.
type SpellId = NonNullable<CharacterSheet["spellcasting"]>["spells"][number];

// SRD 5.1's multiclass spellcaster table: every full-caster class level
// contributes its own level, every half-caster (Paladin, Ranger) contributes
// half (rounded down), to one shared slot pool — reusing fullCasterSlots
// above, since a full caster's own progression already *is* that table at
// combined level = character level. A hero with only a Pact caster
// (Warlock) still uses its own table unchanged. Warlock levels alongside
// another class grant nothing to the shared pool: Pact Magic is SRD's own
// separate, short-rest-recharging resource, and modeling that second pool
// (with its own recharge timing) is out of scope here — documented, not
// guessed at, the same as the race Traits this branch leaves unmodeled.
function combinedSpellcasting(
  classLevels: Readonly<Partial<Record<BuildClass, number>>>,
  previous: CharacterSheet["spellcasting"],
): CharacterSheet["spellcasting"] {
  const entries = (Object.entries(classLevels) as readonly [BuildClass, number | undefined][]).filter(
    (entry): entry is [BuildClass, number] => (entry[1] ?? 0) > 0,
  );
  const soleClass = entries.length === 1 ? entries[0] : undefined;
  if (soleClass !== undefined && classTemplates[soleClass[0]].casterType === "pact") {
    const [buildClass, level] = soleClass;
    const template = classTemplates[buildClass];
    if (template.spellcastingAbility === null) return null;
    return { ability: template.spellcastingAbility, spells: previous?.spells ?? template.firstSpells, slots: spellSlotsForLevel("pact", level) };
  }

  let combinedLevel = 0;
  let ability: Ability | null = null;
  const spells = new Set<SpellId>(previous?.spells ?? []);
  for (const [buildClass, level] of entries) {
    const template = classTemplates[buildClass];
    if (template.casterType === "full") combinedLevel += level;
    else if (template.casterType === "half") combinedLevel += Math.floor(level / 2);
    else continue; // A Pact caster alongside another class, or a non-caster, adds nothing here.
    if (ability === null) ability = template.spellcastingAbility;
    const known = level === 1 ? (template.spellcasting?.spells ?? template.firstSpells) : template.firstSpells;
    for (const id of known) spells.add(id);
  }
  if (combinedLevel === 0 || ability === null) return null;
  return { ability, spells: [...spells], slots: spellSlotsForLevel("full", combinedLevel) };
}

// The next state of a hero's numbers after gaining a level in `buildClass` —
// which may be a class the hero already has levels in, or a brand-new one
// (multiclassing in): hit points off that class's own Hit Die, its own
// level-based features (its level-1 features too, the first time), the
// multiclass skill it grants on a first level if any, spell slots recombined
// across every class held, and — on an ASI level, SRD 5.1's own fixed list,
// independent of which class is being leveled — ability scores. Pure; the
// caller (combat/combat-flow.ts's grantExperience, engine/members.ts's
// chooseClassLevel) checks canMulticlassInto first and emits the event.
export function levelUp(
  sheet: CharacterSheet,
  buildClass: BuildClass,
  skillChoice?: Skill,
): Pick<CharacterSheet, "level" | "maxHp" | "abilityScores" | "spellcasting" | "features" | "skills"> & {
  readonly classLevels: Readonly<Partial<Record<BuildClass, number>>>;
} {
  const level = sheet.level + 1;
  const template = classTemplates[buildClass];
  const hpGain = hpGainForLevel(template.hitDie, sheet.abilityScores.con);
  const abilityScores = asiLevels.includes(level) ? defaultAsiAllocation(buildClass, sheet.abilityScores) : sheet.abilityScores;

  const priorLevels = classLevelsOf(sheet);
  const priorInClass = priorLevels[buildClass] ?? 0;
  const isNewClass = priorInClass === 0;
  const classLevel = priorInClass + 1;
  const classLevels: Partial<Record<BuildClass, number>> = { ...priorLevels, [buildClass]: classLevel };

  const spellcasting = combinedSpellcasting(classLevels, sheet.spellcasting);

  const gained = [...(isNewClass ? template.features : []), ...(template.levelFeatures[classLevel] ?? [])];
  const features = gained.length === 0 ? sheet.features : [...sheet.features, ...gained];

  const skills = { ...sheet.skills };
  if (isNewClass && template.multiclassSkillChoices !== undefined && template.multiclassSkillChoices.length > 0) {
    const choice = skillChoice !== undefined && template.multiclassSkillChoices.includes(skillChoice) ? skillChoice : template.multiclassSkillChoices[0];
    if (choice !== undefined && skills[choice] === undefined) skills[choice] = "proficient";
  }

  return { level, maxHp: sheet.maxHp + hpGain, abilityScores, spellcasting, features, classLevels, skills };
}
