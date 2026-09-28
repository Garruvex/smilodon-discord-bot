import type { CharacterId, UserId } from "../core/ids.js";
import type { ContentId } from "../rules/content-id.js";
import type { Ability } from "../rules/effects.js";
import { skillAbilities, type Skill } from "../rules/skills.js";

// Skills moved to rules/skills.ts (Content), so class content (skillChoices)
// can reference the type; re-exported here since this is where every other
// file already imports them from.
export { skillAbilities, skills, isSkill, type Skill } from "../rules/skills.js";

// Expertise (Rogue) doubles the proficiency bonus.
export type SkillProficiency = "proficient" | "expertise";

// The slice of a hero the exploration engine reads. Class features, items,
// and resources join this as their mechanics are implemented.
export interface CharacterSheet {
  readonly id: CharacterId;
  readonly ownerUserId: UserId;
  readonly name: string;
  // The class as the table reads it, in the campaign's language (display
  // only): always the hero's first class, even once multiclassed — showing
  // every class held is a Discord-layer task, out of scope here.
  readonly className?: string;
  // Levels held in each class, keyed by its builder slug (e.g. "fighter"),
  // for a multiclassed hero. Optional so a sheet from before multiclassing
  // existed still loads; classLevelsOf (character-build.ts) falls back to
  // { [className]: level } when absent. Their sum is always `level` below.
  readonly classLevels?: Readonly<Partial<Record<string, number>>>;
  // Declared by the chooseClassLevel command: which class the hero's *next*
  // level lands in (and which multiclass skill to grant, if that class
  // offers one and this would be the hero's first level in it). Cleared once
  // spent. Absent means "keep leveling the class already being leveled."
  readonly pendingClassLevel?: { readonly buildClass: string; readonly skillChoice?: Skill };
  // The race chosen at creation, if any: races are optional so a sheet from
  // before this content existed still loads. Ability score increases and
  // speed are folded into abilityScores/speed once, at creation; combat
  // reads the race's own traits straight from content (combatant-profile.ts's
  // heroTraits), the same way it reads a feature's or a worn item's.
  readonly race?: ContentId<"race">;
  readonly abilityScores: Readonly<Record<Ability, number>>;
  readonly proficiencyBonus: number;
  readonly skills: Readonly<Partial<Record<Skill, SkillProficiency>>>;
  readonly savingThrows: readonly Ability[];
  readonly level: number;
  // Total XP earned. Absent on a sheet from before leveling existed, which
  // reads as 0 (character/leveling.ts).
  readonly xp?: number;
  readonly maxHp: number;
  // Die size of the class's Hit Dice; there are `level` of them.
  readonly hitDie: 6 | 8 | 10 | 12;
  readonly speed: number;
  // Weapons, armor, and shields carried and used. Armor class is derived
  // from these; heroes are proficient with what they carry.
  readonly equipment: readonly ContentId<"item">[];
  // The armor and shield actually worn (2014 rules: one armor and one shield).
  // Absent: the first armor and the first shield carried are worn, as adventures write them.
  // Weapons are drawn as needed, so they need no slot; anything else carried
  // (spare armor, potions) is in the pack.
  readonly worn?: readonly ContentId<"item">[];
  readonly features: readonly ContentId<"feature">[];
  readonly spellcasting: Spellcasting | null;
  // Pact Magic (Warlock): a second, separate pool of slots that recovers on
  // a short rest, not just a long one — SRD 5.1's actual distinction from
  // every other caster's slots (`spellcasting.slots` above). Present exactly
  // when the hero holds Warlock levels; its ability is `spellcasting.ability`
  // (always Charisma for a Warlock, and this character's one ability for
  // spellcasting generally — the same single-ability simplification every
  // multiclassed caster already takes, character/leveling.ts's
  // combinedSpellcasting). Spending prefers `spellcasting.slots` first,
  // falling back to this pool (engine/combat/evolve-combat.ts's spendSlot).
  readonly pactMagic?: { readonly slots: Readonly<Record<number, number>> };
  // A hero brought from the character library: the library character and the
  // exact snapshot this campaign's copy was made from. Progress saved from
  // this campaign continues from that snapshot on its own branch.
  readonly origin?: { readonly libraryCharacterId: string; readonly snapshotId: string };
}

export interface Spellcasting {
  readonly ability: Ability;
  // Cantrips known and spells prepared.
  readonly spells: readonly ContentId<"spell">[];
  // Spell slots per slot level, e.g. { 1: 2 } for a level 1 cleric.
  readonly slots: Readonly<Record<number, number>>;
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
