import type { Ability } from "./effects.js";

// SRD 5.1 skills and the ability each one uses. Lives in Content (not
// Character) so class definitions (content-definitions.ts's skillChoices)
// can reference the type without Content reaching up into Character.
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
