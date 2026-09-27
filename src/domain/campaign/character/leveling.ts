import type { Ability } from "../rules/effects.js";
import { abilityModifier, type CharacterSheet } from "./character-sheet.js";
import { classTemplates, type BuildClass } from "./character-build.js";

// XP and levels on top of the class roster (character-build.ts): the
// roster stops at what a level-1 hero has; this is what changes as they earn
// XP. Numbers only — hit points, proficiency bonus, spell slots, and ability
// score improvements all follow the SRD tables below, so a new level needs
// no hand-authored content. Level 2+ class features (Rage's resistance, Wild
// Shape, subclass choices, and so on) stay out of scope, same as the roster.

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

export type CasterType = "full" | "half" | "pact" | "none";

const fullCasters = new Set<BuildClass>(["bard", "cleric", "druid", "sorcerer", "wizard"]);
const halfCasters = new Set<BuildClass>(["paladin", "ranger"]);
const pactCasters = new Set<BuildClass>(["warlock"]);

export function casterTypeOf(buildClass: BuildClass): CasterType {
  if (fullCasters.has(buildClass)) return "full";
  if (halfCasters.has(buildClass)) return "half";
  if (pactCasters.has(buildClass)) return "pact";
  return "none";
}

// The ability every spell a class knows keys off, independent of whether the
// class has any spells yet at level 1 (paladin and ranger get none until
// level 2, so their level-1 template carries no spellcasting to read it from).
const spellcastingAbility: Readonly<Record<BuildClass, Ability | null>> = {
  fighter: null,
  rogue: null,
  cleric: "wis",
  barbarian: null,
  bard: "cha",
  druid: "wis",
  monk: null,
  paladin: "cha",
  ranger: "wis",
  sorcerer: "cha",
  warlock: "cha",
  wizard: "int",
};

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

// The next state of a hero's numbers after gaining a level: hit points,
// proficiency bonus, spell slots (added the first time a half-caster or
// pact caster reaches the level that grants them), and — on an ASI level —
// ability scores. Pure; the caller emits the event and applies it.
export function levelUp(sheet: CharacterSheet, buildClass: BuildClass): Pick<CharacterSheet, "level" | "maxHp" | "abilityScores" | "spellcasting"> {
  const level = sheet.level + 1;
  const hpGain = hpGainForLevel(sheet.hitDie, sheet.abilityScores.con);
  const abilityScores = asiLevels.includes(level) ? defaultAsiAllocation(buildClass, sheet.abilityScores) : sheet.abilityScores;
  const casterType = casterTypeOf(buildClass);
  const slots = spellSlotsForLevel(casterType, level);
  const ability = spellcastingAbility[buildClass];
  const spellcasting = casterType === "none" || ability === null ? null : { ability, spells: sheet.spellcasting?.spells ?? [], slots };
  return { level, maxHp: sheet.maxHp + hpGain, abilityScores, spellcasting };
}
