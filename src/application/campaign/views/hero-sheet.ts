import { abilityModifier, checkModifier, passivePerception, savingThrowModifier, type CharacterSheet } from "../../../domain/campaign/character/character-sheet.js";
import { canMulticlassInto, classTemplates, hitDicePool } from "../../../domain/campaign/character/character-build.js";
import { fightingStyles, heldFightingStyle } from "../../../domain/campaign/character/fighting-styles.js";
import { levelUp, maxLevel, nextClassFor, xpForNextLevel, xpThresholds, classChoicesFor } from "../../../domain/campaign/character/leveling.js";
import { heldInvocations, heldPactBoon, invocationOptions, invocationSlots, pactBoonLevel, pactBoons } from "../../../domain/campaign/character/warlock-choices.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import { abilities, type Ability } from "../../../domain/campaign/rules/effects.js";
import { skillAbilities, skills, type Skill } from "../../../domain/campaign/rules/skills.js";

// The hero's own sheet and what they may choose when they level up, as plain data: the page words it, the engine decides every choice.
export interface HeroSheetView {
  readonly abilities: readonly { readonly ability: Ability; readonly score: number; readonly modifier: number }[];
  readonly proficiencyBonus: number;
  readonly speed: number;
  readonly initiative: number;
  readonly passivePerception: number;
  readonly skills: readonly { readonly skill: Skill; readonly ability: Ability; readonly bonus: number; readonly proficiency: "none" | "proficient" | "expertise" }[];
  readonly saves: readonly { readonly ability: Ability; readonly bonus: number; readonly proficient: boolean }[];
  // xp is null in a milestone game, where levels are handed out rather than earned.
  readonly progress: { readonly level: number; readonly xp: number | null; readonly floor: number; readonly next: number | null };
  readonly hitDice: { readonly left: number; readonly max: number; readonly dice: readonly number[] };
  readonly features: readonly { readonly id: string; readonly name: string }[];
}

export interface LevelUpView {
  readonly pendingAsi: number;
  readonly scores: Readonly<Record<Ability, number>>;
  // The class the next level lands in, with what it brings. Null at the top level.
  readonly classPlan: null | {
    readonly landing: string;
    readonly level: number;
    readonly hpGain: number;
    readonly gains: readonly string[];
    readonly choices: readonly { readonly buildClass: string; readonly current: boolean; readonly level: number; readonly allowed: boolean; readonly requires: readonly (readonly Ability[])[] }[];
    readonly skillOptions: readonly Skill[];
    readonly skill: Skill | null;
  };
  readonly fightingStyle: null | { readonly held: string; readonly options: readonly { readonly id: string; readonly name: string }[] };
  readonly warlock: null | {
    readonly slots: number;
    readonly held: readonly string[];
    readonly options: readonly { readonly id: string; readonly name: string }[];
    readonly boon: null | { readonly held: string | null; readonly options: readonly { readonly id: string; readonly name: string }[] };
  };
  // Anything here to decide or change at all.
  readonly owed: boolean;
}

export function buildHeroSheetView(sheet: CharacterSheet, hitDicesLeft: number | undefined, milestone: boolean, glossary: Glossary): HeroSheetView {
  const name = (id: string): string => glossary.names[id] ?? id.replace(/^[a-z]+:/, "").replaceAll("-", " ");
  return {
    abilities: abilities.map((ability) => ({ ability, score: sheet.abilityScores[ability], modifier: abilityModifier(sheet.abilityScores[ability]) })),
    proficiencyBonus: sheet.proficiencyBonus,
    speed: sheet.speed,
    initiative: abilityModifier(sheet.abilityScores.dex),
    passivePerception: passivePerception(sheet),
    skills: skills.map((skill) => ({ skill, ability: skillAbilities[skill], bonus: checkModifier(sheet, { kind: "skill", skill }), proficiency: sheet.skills[skill] === "expertise" ? "expertise" : sheet.skills[skill] === "proficient" ? "proficient" : "none" })),
    saves: abilities.map((ability) => ({ ability, bonus: savingThrowModifier(sheet, ability), proficient: savingThrowModifier(sheet, ability) > abilityModifier(sheet.abilityScores[ability]) })),
    progress: { level: sheet.level, xp: milestone ? null : sheet.xp ?? 0, floor: xpThresholds[sheet.level - 1] ?? 0, next: milestone ? null : xpForNextLevel(sheet.level) },
    hitDice: { left: hitDicesLeft ?? sheet.level, max: sheet.level, dice: hitDicePool(sheet) },
    features: sheet.features.map((id) => ({ id, name: name(id) })),
  };
}

export function buildLevelUpView(sheet: CharacterSheet, glossary: Glossary): LevelUpView {
  const name = (id: string): string => glossary.names[id] ?? id.replace(/^[a-z]+:/, "").replaceAll("-", " ");
  const pendingAsi = sheet.pendingAsi ?? 0;
  const landing = sheet.level >= maxLevel ? null : nextClassFor(sheet);
  const held = sheet.classLevels ?? {};
  const classPlan: LevelUpView["classPlan"] = landing === null ? null : ((): NonNullable<LevelUpView["classPlan"]> => {
    const planned = sheet.pendingClassLevel?.buildClass === landing ? sheet.pendingClassLevel.skillChoice : undefined;
    const preview = levelUp(sheet, landing, planned);
    const isNew = (held[landing] ?? 0) === 0 && landing !== sheet.className;
    const skillOptions = isNew ? classTemplates[landing].multiclassSkillChoices ?? [] : [];
    const allowedNow = new Set(classChoicesFor(sheet).map((choice) => choice.buildClass));
    return {
      landing,
      level: preview.level,
      hpGain: preview.maxHp - sheet.maxHp,
      gains: preview.features.slice(sheet.features.length).map(name),
      choices: (Object.keys(classTemplates) as (keyof typeof classTemplates)[]).map((buildClass) => ({
        buildClass,
        current: (held[buildClass] ?? 0) > 0 || (Object.keys(held).length === 0 && buildClass === sheet.className),
        level: held[buildClass] ?? (buildClass === sheet.className ? sheet.level : 0),
        allowed: allowedNow.has(buildClass) && canMulticlassInto(buildClass, sheet),
        requires: classTemplates[buildClass].multiclassRequires,
      })),
      skillOptions,
      skill: skillOptions.length === 0 ? null : planned ?? skillOptions[0] ?? null,
    };
  })();
  const style = heldFightingStyle(sheet.features);
  const warlockLevel = sheet.classLevels?.warlock ?? (sheet.className === "warlock" ? sheet.level : 0);
  const boonHeld = heldPactBoon(sheet.features);
  const fightingStyle = style === null ? null : { held: style, options: fightingStyles.map((id) => ({ id, name: name(id) })) };
  const warlock = warlockLevel < 2 ? null : {
    slots: invocationSlots(warlockLevel),
    held: [...heldInvocations(sheet.features)],
    options: invocationOptions.map((id) => ({ id, name: name(id) })),
    boon: warlockLevel >= pactBoonLevel ? { held: boonHeld, options: pactBoons.map((id) => ({ id, name: name(id) })) } : null,
  };
  return { pendingAsi, scores: sheet.abilityScores, classPlan, fightingStyle, warlock, owed: pendingAsi > 0 };
}
