import type { ContentId } from "../rules/content-id.js";
import type { Ability } from "../rules/effects.js";
import { abilities } from "../rules/effects.js";
import { abilityModifier, isSkill, type CharacterSheet, type Skill, type SkillProficiency } from "./character-sheet.js";

// The guided character builder's rules (plan §3, Character creation). A build
// is the player's choices; every number on the sheet is derived from them
// here, by the engine, never taken from a person or a model. The catalog is
// three level-1 classes, so that is what can be built.

export const buildClasses = ["fighter", "rogue", "cleric"] as const;
export type BuildClass = (typeof buildClasses)[number];

export function isBuildClass(value: string): value is BuildClass {
  return (buildClasses as readonly string[]).includes(value);
}

// SRD 5.1 standard array: each score is used once.
export const standardArray: readonly number[] = [15, 14, 13, 12, 10, 8];

export interface BuildChoices {
  readonly class: BuildClass;
  // One of the class's starting kits (see classTemplates).
  readonly kit: string;
  readonly abilities: Readonly<Record<Ability, number>>;
  // The class's chosen skill proficiencies, and (rogue) which two of them get expertise.
  readonly skills: readonly Skill[];
  readonly expertise: readonly Skill[];
  readonly name: string;
  // What the character looks like and what the player says about their past:
  // the table's own words, kept short and never read as rules.
  readonly appearance: string;
  readonly backstory: string;
}

export interface StartingKit {
  readonly id: string;
  readonly equipment: readonly ContentId<"item">[];
}

export interface ClassTemplate {
  readonly id: BuildClass;
  readonly hitDie: 6 | 8 | 10 | 12;
  readonly savingThrows: readonly Ability[];
  // The skills the class may choose from, how many, and how many get expertise.
  readonly skillChoices: readonly Skill[];
  readonly skillCount: number;
  readonly expertiseCount: number;
  readonly features: readonly ContentId<"feature">[];
  readonly kits: readonly StartingKit[];
  readonly spellcasting: { readonly ability: Ability; readonly spells: readonly ContentId<"spell">[]; readonly slots: Readonly<Record<number, number>> } | null;
  // The abilities worth the highest scores, as a suggestion for the builder's default.
  readonly suggested: readonly Ability[];
}

const item = (name: string): ContentId<"item"> => `item:${name}`;
const feature = (name: string): ContentId<"feature"> => `feature:${name}`;
const spell = (name: string): ContentId<"spell"> => `spell:${name}`;

export const classTemplates: Readonly<Record<BuildClass, ClassTemplate>> = {
  fighter: {
    id: "fighter",
    hitDie: 10,
    savingThrows: ["str", "con"],
    skillChoices: ["acrobatics", "animal-handling", "athletics", "history", "insight", "intimidation", "perception", "survival"],
    skillCount: 2,
    expertiseCount: 0,
    features: [feature("fighting-style-dueling"), feature("second-wind")],
    kits: [
      { id: "knight", equipment: [item("longsword"), item("chain-mail"), item("shield")] },
      { id: "skirmisher", equipment: [item("scimitar"), item("shortbow"), item("leather-armor")] },
    ],
    spellcasting: null,
    suggested: ["str", "con", "dex", "wis", "int", "cha"],
  },
  rogue: {
    id: "rogue",
    hitDie: 8,
    savingThrows: ["dex", "int"],
    skillChoices: ["acrobatics", "athletics", "deception", "insight", "intimidation", "investigation", "perception", "performance", "persuasion", "sleight-of-hand", "stealth"],
    skillCount: 4,
    expertiseCount: 2,
    features: [feature("sneak-attack"), feature("thieves-cant")],
    kits: [
      { id: "shadow", equipment: [item("shortsword"), item("shortbow"), item("leather-armor")] },
      { id: "duelist", equipment: [item("scimitar"), item("shortsword"), item("leather-armor")] },
    ],
    spellcasting: null,
    suggested: ["dex", "cha", "int", "con", "wis", "str"],
  },
  cleric: {
    id: "cleric",
    hitDie: 8,
    savingThrows: ["wis", "cha"],
    skillChoices: ["history", "insight", "medicine", "persuasion", "religion"],
    skillCount: 2,
    expertiseCount: 0,
    features: [feature("disciple-of-life")],
    kits: [
      // The Life Domain grants heavy armor proficiency.
      { id: "shieldbearer", equipment: [item("mace"), item("chain-mail"), item("shield")] },
      { id: "wayfarer", equipment: [item("mace"), item("leather-armor"), item("shield"), item("javelin")] },
    ],
    // Bless and Cure Wounds are Life Domain spells, always prepared; the other
    // level 1 cleric spells the catalog has are prepared too (the limit,
    // Wisdom modifier plus level, is never below this many with the standard array).
    spellcasting: {
      ability: "wis",
      spells: [spell("sacred-flame"), spell("thaumaturgy"), spell("bless"), spell("cure-wounds"), spell("healing-word"), spell("guiding-bolt")],
      slots: { 1: 2 },
    },
    suggested: ["wis", "con", "str", "cha", "dex", "int"],
  },
};

export const maxNameLength = 40;
export const maxBackgroundLength = 300;

// Every reason a build cannot be made, in the builder's own words (codes the
// Discord layer localizes). Empty when the build is legal.
export type BuildProblem =
  | { readonly code: "unknownClass" }
  | { readonly code: "unknownKit"; readonly kit: string }
  | { readonly code: "abilitiesNotStandardArray" }
  | { readonly code: "skillCount"; readonly expected: number }
  | { readonly code: "skillNotAllowed"; readonly skill: string }
  | { readonly code: "skillRepeated"; readonly skill: string }
  | { readonly code: "expertiseCount"; readonly expected: number }
  | { readonly code: "expertiseNotProficient"; readonly skill: string }
  | { readonly code: "badName" }
  | { readonly code: "textTooLong" };

export function buildProblems(build: BuildChoices): readonly BuildProblem[] {
  const template = classTemplates[build.class] as ClassTemplate | undefined;
  if (template === undefined) return [{ code: "unknownClass" }];
  const problems: BuildProblem[] = [];
  if (!template.kits.some((kit) => kit.id === build.kit)) problems.push({ code: "unknownKit", kit: build.kit });
  const scores = abilities.map((ability) => build.abilities[ability]).sort((a, b) => b - a);
  if (scores.length !== standardArray.length || scores.some((score, index) => score !== standardArray[index])) problems.push({ code: "abilitiesNotStandardArray" });
  if (build.skills.length !== template.skillCount) problems.push({ code: "skillCount", expected: template.skillCount });
  const seen = new Set<string>();
  for (const skill of build.skills) {
    if (!isSkill(skill) || !template.skillChoices.includes(skill)) problems.push({ code: "skillNotAllowed", skill });
    else if (seen.has(skill)) problems.push({ code: "skillRepeated", skill });
    seen.add(skill);
  }
  if (build.expertise.length !== template.expertiseCount) problems.push({ code: "expertiseCount", expected: template.expertiseCount });
  for (const skill of build.expertise) if (!build.skills.includes(skill)) problems.push({ code: "expertiseNotProficient", skill });
  if ([...build.name.trim()].length < 1 || [...build.name.trim()].length > maxNameLength) problems.push({ code: "badName" });
  if ([...build.appearance].length > maxBackgroundLength || [...build.backstory].length > maxBackgroundLength) problems.push({ code: "textTooLong" });
  return problems;
}

// The gear a build starts with.
export function kitEquipment(build: Pick<BuildChoices, "class" | "kit">): readonly ContentId<"item">[] {
  return classTemplates[build.class].kits.find((kit) => kit.id === build.kit)?.equipment ?? [];
}

// What the engine reads of a hero, minus what a campaign assigns (ID and owner).
export type DerivedSheet = Omit<CharacterSheet, "id" | "ownerUserId">;

// Derives every number: hit points from the class's Hit Die and Constitution,
// proficiency +2, the class's saving throws, features, spells and slots. The
// gear is the build's kit unless a saved snapshot brings its own.
export function deriveSheet(build: BuildChoices, gear?: { readonly equipment: readonly ContentId<"item">[]; readonly worn?: readonly ContentId<"item">[] }): DerivedSheet {
  const template = classTemplates[build.class];
  const skills: Partial<Record<Skill, SkillProficiency>> = {};
  for (const skill of build.skills) skills[skill] = build.expertise.includes(skill) ? "expertise" : "proficient";
  const equipment = gear?.equipment ?? kitEquipment(build);
  return {
    name: build.name.trim(),
    className: build.class,
    abilityScores: build.abilities,
    proficiencyBonus: 2,
    skills,
    savingThrows: template.savingThrows,
    level: 1,
    maxHp: Math.max(1, template.hitDie + abilityModifier(build.abilities.con)),
    hitDie: template.hitDie,
    speed: 30,
    equipment,
    ...(gear?.worn === undefined ? {} : { worn: gear.worn }),
    features: template.features,
    spellcasting: template.spellcasting === null ? null : { ability: template.spellcasting.ability, spells: template.spellcasting.spells, slots: template.spellcasting.slots },
  };
}

// The suggested standard-array assignment for a class: highest score to the
// ability it leans on most. The builder starts from it and lets the player change it.
export function suggestedAbilities(buildClass: BuildClass): Readonly<Record<Ability, number>> {
  const order = classTemplates[buildClass].suggested;
  return Object.fromEntries(order.map((ability, index) => [ability, standardArray[index] ?? 8])) as Record<Ability, number>;
}
