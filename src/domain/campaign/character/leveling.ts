import { abilities, type Ability } from "../rules/effects.js";
import type { CasterType } from "../rules/content-definitions.js";
import type { Skill } from "../rules/skills.js";
import { abilityModifier, type CharacterSheet } from "./character-sheet.js";
import { canMulticlassInto, classLevelsOf, classTemplates, deriveSheet, isBuildClass, isBuildRace, raceTemplates, type BuildChoices, type BuildClass, type DerivedSheet } from "./character-build.js";

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
// combined level = character level. Pact Magic (Warlock) is genuinely
// separate — SRD 5.1's own second pool, recovering on a short rest rather
// than a long one — so it is returned apart, always off the Warlock's own
// level alone, whether or not the hero holds any other class. `ability` is
// this character's one spellcasting ability for everything (the multiclass
// simplification every caster already takes: a real multiclass hero keys
// each spell to its own class's ability, not modeled here) — the first
// caster class taken, of any type, so a Warlock-only hero still gets one.
function combinedSpellcasting(
  classLevels: Readonly<Partial<Record<BuildClass, number>>>,
  previous: CharacterSheet["spellcasting"],
): { readonly spellcasting: CharacterSheet["spellcasting"]; readonly pactMagic: CharacterSheet["pactMagic"] } {
  const entries = (Object.entries(classLevels) as readonly [BuildClass, number | undefined][]).filter(
    (entry): entry is [BuildClass, number] => (entry[1] ?? 0) > 0,
  );

  let combinedLevel = 0;
  let pactLevel = 0;
  let ability: Ability | null = null;
  const spells = new Set<SpellId>(previous?.spells ?? []);
  for (const [buildClass, level] of entries) {
    const template = classTemplates[buildClass];
    if (template.casterType === "none") continue;
    if (ability === null) ability = template.spellcastingAbility;
    const known = level === 1 ? (template.spellcasting?.spells ?? template.firstSpells) : template.firstSpells;
    for (const id of known) spells.add(id);
    if (template.casterType === "full") combinedLevel += level;
    else if (template.casterType === "half") combinedLevel += Math.floor(level / 2);
    else pactLevel = level; // Only one class can ever be the Pact caster.
  }
  if (ability === null) return { spellcasting: null, pactMagic: undefined };
  const spellcasting = { ability, spells: [...spells], slots: combinedLevel > 0 ? spellSlotsForLevel("full", combinedLevel) : {} };
  const pactMagic = pactLevel > 0 ? { slots: spellSlotsForLevel("pact", pactLevel) } : undefined;
  return { spellcasting, pactMagic };
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
  sheet: Omit<CharacterSheet, "ownerUserId">,
  buildClass: BuildClass,
  skillChoice?: Skill,
): Pick<CharacterSheet, "level" | "maxHp" | "abilityScores" | "spellcasting" | "features" | "skills" | "pactMagic" | "pendingAsi"> & {
  readonly classLevels: Readonly<Partial<Record<BuildClass, number>>>;
} {
  const level = sheet.level + 1;
  const template = classTemplates[buildClass];
  const raceSlug = sheet.race?.slice("race:".length);
  const race = raceSlug !== undefined && isBuildRace(raceSlug) ? raceTemplates[raceSlug] : undefined;
  const hpGain = hpGainForLevel(template.hitDie, sheet.abilityScores.con) + (race?.bonusHpPerLevel ?? 0);
  // The SRD lets the player choose the allocation (+2 to one ability, or +1
  // to two): this only counts the improvement as owed, it does not pick for
  // them. defaultAsiAllocation stays as the Discord picker's "use the
  // suggestion" shortcut, the same role it already plays nowhere else now.
  const pendingAsi = (sheet.pendingAsi ?? 0) + (asiLevels.includes(level) ? 1 : 0);
  const abilityScores = sheet.abilityScores;

  const priorLevels = classLevelsOf(sheet);
  const priorInClass = priorLevels[buildClass] ?? 0;
  const isNewClass = priorInClass === 0;
  const classLevel = priorInClass + 1;
  const classLevels: Partial<Record<BuildClass, number>> = { ...priorLevels, [buildClass]: classLevel };

  const { spellcasting, pactMagic } = combinedSpellcasting(classLevels, sheet.spellcasting);

  const gained = [...(isNewClass ? template.features : []), ...(template.levelFeatures[classLevel] ?? [])];
  const features = gained.length === 0 ? sheet.features : [...sheet.features, ...gained];

  const skills = { ...sheet.skills };
  if (isNewClass && template.multiclassSkillChoices !== undefined && template.multiclassSkillChoices.length > 0) {
    const choice = skillChoice !== undefined && template.multiclassSkillChoices.includes(skillChoice) ? skillChoice : template.multiclassSkillChoices[0];
    if (choice !== undefined && skills[choice] === undefined) skills[choice] = "proficient";
  }

  return { level, maxHp: sheet.maxHp + hpGain, abilityScores, spellcasting, features, classLevels, skills, pendingAsi, ...(pactMagic === undefined ? {} : { pactMagic }) };
}

// A hero before it has an owner (an adventure's preset, a library snapshot's
// derived sheet) levels the same way a seated one does.
export type Levelable = Omit<CharacterSheet, "ownerUserId">;
export type LevelStep = ReturnType<typeof levelUp>;

// Which class a hero's next level lands in: the class declared by the
// chooseClassLevel command, if it still qualifies (scores can change between
// declaring and reaching the level), otherwise the class already being leveled.
export function nextClassFor(sheet: Levelable): BuildClass | null {
  const pending = sheet.pendingClassLevel;
  if (pending !== undefined && isBuildClass(pending.buildClass) && canMulticlassInto(pending.buildClass, sheet)) return pending.buildClass;
  if (sheet.className !== undefined && isBuildClass(sheet.className)) return sheet.className;
  const [first] = Object.keys(classLevelsOf(sheet));
  return first !== undefined && isBuildClass(first) ? first : null;
}

// Every level a hero gains on the way up to `targetLevel`, one step each, so a
// big jump still lands as a readable sequence. A declared multiclass is spent
// on the first of those levels only; the rest continue whatever class that
// level left the hero leveling (the same one-shot-per-declaration
// simplification the XP path always had).
export function levelSteps(sheet: Levelable, targetLevel: number): readonly LevelStep[] {
  const steps: LevelStep[] = [];
  let current = sheet;
  while (current.level < Math.min(targetLevel, maxLevel)) {
    const buildClass = nextClassFor(current);
    if (buildClass === null) break;
    const skillChoice = current.pendingClassLevel?.buildClass === buildClass ? current.pendingClassLevel.skillChoice : undefined;
    const next = levelUp(current, buildClass, skillChoice);
    steps.push(next);
    const { pendingClassLevel: _spent, ...rest } = current;
    current = { ...rest, ...next };
  }
  return steps;
}

// A hero brought up to `level` in one go (a game that starts above level 1,
// a replacement joining a party that has grown): the level steps, with XP at
// the threshold so the hero reads as exactly that level in either leveling
// mode. Improvements earned on the way are left for the player to spend.
export function raiseToLevel<S extends Levelable>(sheet: S, level: number): S {
  const steps = levelSteps(sheet, level);
  const last = steps[steps.length - 1];
  if (last === undefined) return sheet;
  const { pendingClassLevel: _spent, ...rest } = sheet;
  return { ...rest, ...last, xp: Math.max(sheet.xp ?? 0, xpThresholds[last.level - 1] ?? 0) } as unknown as S;
}

// What the level-up form offers for the hero's next level: the class they are
// leveling (always), and every other class they qualify to multiclass into.
export function classChoicesFor(sheet: Levelable): readonly { readonly buildClass: BuildClass; readonly current: boolean }[] {
  const held = classLevelsOf(sheet);
  return (Object.keys(classTemplates) as BuildClass[])
    .filter((buildClass) => (held[buildClass] ?? 0) > 0 || canMulticlassInto(buildClass, sheet))
    .map((buildClass) => ({ buildClass, current: (held[buildClass] ?? 0) > 0 }));
}

// Saved progress (the character library's Save Progress and export): what a
// hero became since its build's own level 1, kept as the facts that produced
// it rather than as trusted derived numbers, the same "derive, never take a
// stored number" rule a build follows. classLevels is the current total per
// class; multiclassSkills the skill each added class granted on its first
// level; abilityScores the current scores after any Improvements (bounded by
// progressionProblems, not trusted); pendingAsi how many earned improvements
// are still unspent. Hit points, features, spells and slots are all
// recomputed from these by replaying levelUp.
export interface Progression {
  readonly xp: number;
  readonly classLevels: Readonly<Partial<Record<string, number>>>;
  readonly multiclassSkills: Readonly<Partial<Record<string, Skill>>>;
  readonly abilityScores: Readonly<Record<Ability, number>>;
  readonly pendingAsi: number;
}

export type ProgressionProblem =
  | { readonly code: "invalidLevel" }
  | { readonly code: "unknownClass"; readonly buildClass: string }
  | { readonly code: "missingStartingClassLevel" }
  | { readonly code: "xpLevelMismatch" }
  | { readonly code: "abilityScoreOutOfRange" }
  | { readonly code: "asiPointsExceeded" }
  | { readonly code: "pendingAsiExceeded" };

// The progress a live hero has made. A multiclass skill is read back as the
// one of that class's offered skills the hero holds, since a sheet does not
// remember which level granted it.
export function progressionOf(sheet: CharacterSheet): Progression {
  const classLevels = classLevelsOf(sheet);
  const multiclassSkills: Record<string, Skill> = {};
  for (const buildClass of Object.keys(classLevels)) {
    if (buildClass === sheet.className || !isBuildClass(buildClass)) continue;
    const held = (classTemplates[buildClass].multiclassSkillChoices ?? []).find((skill) => sheet.skills[skill] !== undefined);
    if (held !== undefined) multiclassSkills[buildClass] = held;
  }
  return { xp: sheet.xp ?? 0, classLevels, multiclassSkills, abilityScores: sheet.abilityScores, pendingAsi: sheet.pendingAsi ?? 0 };
}

// Every level past the build's own first, one entry each. levelUp accumulates
// by class, not by call order, so the order here never changes the result.
function levelSequence(build: DerivedSheet, classLevels: Readonly<Partial<Record<string, number>>>): readonly BuildClass[] {
  const sequence: BuildClass[] = [];
  for (const [buildClass, count] of Object.entries(classLevels)) {
    if (!isBuildClass(buildClass) || count === undefined) continue;
    const already = buildClass === build.className ? 1 : 0;
    for (let index = 0; index < count - already; index += 1) sequence.push(buildClass);
  }
  return sequence;
}

export function progressionProblems(build: DerivedSheet, progression: Progression): readonly ProgressionProblem[] {
  const problems: ProgressionProblem[] = [];
  const counts = Object.values(progression.classLevels);
  const level = counts.reduce((sum: number, count) => sum + (count ?? 0), 0);
  if (counts.some((count) => count === undefined || !Number.isInteger(count) || count < 1) || level < 1 || level > maxLevel) problems.push({ code: "invalidLevel" });
  for (const buildClass of Object.keys(progression.classLevels)) if (!isBuildClass(buildClass)) problems.push({ code: "unknownClass", buildClass });
  if (build.className !== undefined && (progression.classLevels[build.className] ?? 0) < 1) problems.push({ code: "missingStartingClassLevel" });
  if (problems.length > 0) return problems;
  if (!Number.isInteger(progression.xp) || levelForXp(progression.xp) !== level) problems.push({ code: "xpLevelMismatch" });

  const asiLevelsCrossed = asiLevels.filter((asiLevel) => asiLevel <= level).length;
  let pointsSpent = 0;
  for (const ability of abilities) {
    const before = build.abilityScores[ability];
    const after = progression.abilityScores[ability];
    if (!Number.isInteger(after) || after < before || after > 20) problems.push({ code: "abilityScoreOutOfRange" });
    else pointsSpent += after - before;
  }
  if (pointsSpent > asiLevelsCrossed * 2) problems.push({ code: "asiPointsExceeded" });
  if (!Number.isInteger(progression.pendingAsi) || progression.pendingAsi < 0 || progression.pendingAsi > asiLevelsCrossed) problems.push({ code: "pendingAsiExceeded" });
  return problems;
}

// Replays the saved progress onto the build's level-1 sheet with levelUp
// itself, so hit points, features, spells and slots come out exactly as they
// did live. The improved scores are in place from the start, so every level's
// hit points use the final Constitution, the same no-retroactive-HP
// simplification chooseAsi already accepts. Callers check progressionProblems first.
export function applyProgression(build: DerivedSheet, progression: Progression): DerivedSheet {
  let sheet: DerivedSheet = { ...build, abilityScores: progression.abilityScores };
  for (const buildClass of levelSequence(build, progression.classLevels)) {
    const next = levelUp(sheet as unknown as CharacterSheet, buildClass, progression.multiclassSkills[buildClass]);
    sheet = { ...sheet, ...next };
  }
  return { ...sheet, xp: progression.xp, pendingAsi: progression.pendingAsi };
}

// The sheet a snapshot plays as: its build and gear, plus any saved progress.
export function deriveSnapshotSheet(build: BuildChoices, gear: Parameters<typeof deriveSheet>[1], progression: Progression | undefined): DerivedSheet {
  const base = deriveSheet(build, gear);
  return progression === undefined ? base : applyProgression(base, progression);
}
