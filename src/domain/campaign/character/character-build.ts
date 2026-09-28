import { srd51Classes } from "../content/srd-5.1/classes.js";
import { srd51Races } from "../content/srd-5.1/races.js";
import { parseContentId, type ContentId } from "../rules/content-id.js";
import type { ClassDefinition, RaceDefinition } from "../rules/content-definitions.js";
import type { Ability } from "../rules/effects.js";
import { abilities } from "../rules/effects.js";
import { abilityModifier, isSkill, type CharacterSheet, type Skill, type SkillProficiency } from "./character-sheet.js";

// The guided character builder's rules (plan §3, Character creation). A build
// is the player's choices; every number on the sheet is derived from them
// here, by the engine, never taken from a person or a model. Classes and
// races are sealed content (content/srd-5.1/classes.ts, races.ts): the same
// data content-registry.ts validates for every spell, item, and monster, so
// a class or race with a missing feature, spell, or kit item fails the build
// the way any other broken content would, not silently at chargen time. This
// module just re-shapes that content for the builder: it needs no
// SealedContent of its own since a build is always for the SRD 5.1 roster,
// the same coupling the kit gear (literal "item:longsword" IDs) already has.
export type { StartingKit } from "../rules/content-definitions.js";

export const buildClasses = [
  "fighter",
  "rogue",
  "cleric",
  "barbarian",
  "bard",
  "druid",
  "monk",
  "paladin",
  "ranger",
  "sorcerer",
  "warlock",
  "wizard",
] as const;
export type BuildClass = (typeof buildClasses)[number];

export function isBuildClass(value: string): value is BuildClass {
  return (buildClasses as readonly string[]).includes(value);
}

export const buildRaces = ["human", "elf", "dwarf", "halfling", "dragonborn", "gnome", "half-elf", "half-orc", "tiefling"] as const;
export type BuildRace = (typeof buildRaces)[number];

export function isBuildRace(value: string): value is BuildRace {
  return (buildRaces as readonly string[]).includes(value);
}

function slugOf(id: ContentId): string {
  const parsed = parseContentId(id);
  if (parsed === null) throw new Error(`"${id}" is not a valid content ID.`);
  return parsed.slug;
}

function byBuildKey<Slug extends string, Definition extends { readonly id: ContentId }>(
  definitions: readonly Definition[],
  isKnown: (value: string) => value is Slug,
  what: string,
): Readonly<Record<Slug, Definition>> {
  const entries = definitions.map((definition): readonly [Slug, Definition] => {
    const slug = slugOf(definition.id);
    if (!isKnown(slug)) throw new Error(`${what} content "${definition.id}" is not one of the builder's known ${what}s.`);
    return [slug, definition];
  });
  return Object.fromEntries(entries) as Readonly<Record<Slug, Definition>>;
}

// The class roster's full data, keyed the way the builder (and every
// existing caller) already spells a class: "fighter", not "class:fighter".
export const classTemplates: Readonly<Record<BuildClass, ClassDefinition>> = byBuildKey(srd51Classes, isBuildClass, "class");

export const raceTemplates: Readonly<Record<BuildRace, RaceDefinition>> = byBuildKey(srd51Races, isBuildRace, "race");

function raceContentId(race: BuildRace): ContentId<"race"> {
  return `race:${race}`;
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
  // Optional so a build made before races existed (or a caller that has not
  // added a race picker yet — the Discord builder does not, still) stays
  // legal; deriveSheet applies no racial bonus and the SRD default speed
  // when it is absent.
  readonly race?: BuildRace;
}

// Every reason a build cannot be made, in the builder's own words (codes the
// Discord layer localizes). Empty when the build is legal.
export type BuildProblem =
  | { readonly code: "unknownClass" }
  | { readonly code: "unknownRace" }
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
  const template = classTemplates[build.class] as ClassDefinition | undefined;
  if (template === undefined) return [{ code: "unknownClass" }];
  const problems: BuildProblem[] = [];
  if (build.race !== undefined && !isBuildRace(build.race)) problems.push({ code: "unknownRace" });
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

export const maxNameLength = 40;
export const maxBackgroundLength = 300;

// The gear a build starts with.
export function kitEquipment(build: Pick<BuildChoices, "class" | "kit">): readonly ContentId<"item">[] {
  return classTemplates[build.class].kits.find((kit) => kit.id === build.kit)?.equipment ?? [];
}

// What the engine reads of a hero, minus what a campaign assigns (ID and owner).
export type DerivedSheet = Omit<CharacterSheet, "id" | "ownerUserId">;

// Every ability a race's fixed bonus raises, added once at creation (SRD
// 5.1 applies racial increases before anything derived from ability scores,
// so this runs before the hit-point calculation below).
function withAbilityScoreIncrease(scores: Readonly<Record<Ability, number>>, increase: Readonly<Partial<Record<Ability, number>>>): Readonly<Record<Ability, number>> {
  const result: Record<Ability, number> = { ...scores };
  for (const ability of abilities) result[ability] = scores[ability] + (increase[ability] ?? 0);
  return result;
}

// Derives every number: hit points from the class's Hit Die and Constitution,
// proficiency +2, the class's saving throws, features, spells and slots. The
// gear is the build's kit unless a saved snapshot brings its own. A chosen
// race folds its ability score increase and speed in; combat reads the
// race's own traits straight from content (combatant-profile.ts's heroTraits).
export function deriveSheet(build: BuildChoices, gear?: { readonly equipment: readonly ContentId<"item">[]; readonly worn?: readonly ContentId<"item">[] }): DerivedSheet {
  const template = classTemplates[build.class];
  const race = build.race === undefined ? undefined : raceTemplates[build.race];
  const abilityScores = race === undefined ? build.abilities : withAbilityScoreIncrease(build.abilities, race.abilityScoreIncrease);
  const skills: Partial<Record<Skill, SkillProficiency>> = {};
  for (const skill of build.skills) skills[skill] = build.expertise.includes(skill) ? "expertise" : "proficient";
  const equipment = gear?.equipment ?? kitEquipment(build);
  return {
    name: build.name.trim(),
    className: build.class,
    ...(build.race === undefined ? {} : { race: raceContentId(build.race) }),
    abilityScores,
    proficiencyBonus: 2,
    skills,
    savingThrows: template.savingThrows,
    level: 1,
    xp: 0,
    maxHp: Math.max(1, template.hitDie + abilityModifier(abilityScores.con)),
    hitDie: template.hitDie,
    speed: race?.speed ?? 30,
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
