import type { CharacterId, UserId } from "../core/ids.js";
import type { Ability } from "../rules/effects.js";

// SRD 5.1 skills and the ability each one uses.
export const skillAbilities = {
  acrobatics: "dex",
  "animal-handling": "wis",
  arcana: "int",
  athletics: "str",
  deception: "cha",
  history: "int",
  insight: "wis",
  intimidation: "cha",
  investigation: "int",
  medicine: "wis",
  nature: "int",
  perception: "wis",
  performance: "cha",
  persuasion: "cha",
  religion: "int",
  "sleight-of-hand": "dex",
  stealth: "dex",
  survival: "wis",
} as const satisfies Record<string, Ability>;

export type Skill = keyof typeof skillAbilities;
export const skills = Object.keys(skillAbilities) as readonly Skill[];

export function isSkill(value: string): value is Skill {
  return Object.hasOwn(skillAbilities, value);
}

// Expertise (Rogue) doubles the proficiency bonus.
export type SkillProficiency = "proficient" | "expertise";

// The slice of a hero the exploration engine reads. Class features, items,
// and resources join this as their mechanics are implemented.
export interface CharacterSheet {
  readonly id: CharacterId;
  readonly ownerUserId: UserId;
  readonly name: string;
  readonly abilityScores: Readonly<Record<Ability, number>>;
  readonly proficiencyBonus: number;
  readonly skills: Readonly<Partial<Record<Skill, SkillProficiency>>>;
  readonly savingThrows: readonly Ability[];
}

// An ability check, optionally using a skill.
export type CheckTest =
  | { readonly kind: "ability"; readonly ability: Ability }
  | { readonly kind: "skill"; readonly skill: Skill };

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function abilityOf(test: CheckTest): Ability {
  return test.kind === "skill" ? skillAbilities[test.skill] : test.ability;
}

export function checkModifier(sheet: CharacterSheet, test: CheckTest): number {
  const base = abilityModifier(sheet.abilityScores[abilityOf(test)]);
  if (test.kind === "ability") return base;
  const proficiency = sheet.skills[test.skill];
  if (proficiency === "expertise") return base + sheet.proficiencyBonus * 2;
  if (proficiency === "proficient") return base + sheet.proficiencyBonus;
  return base;
}

export function savingThrowModifier(sheet: CharacterSheet, ability: Ability): number {
  const base = abilityModifier(sheet.abilityScores[ability]);
  return sheet.savingThrows.includes(ability) ? base + sheet.proficiencyBonus : base;
}
