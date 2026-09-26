import { abilityModifier, type CharacterSheet } from "../character/character-sheet.js";
import { plus } from "../dice/dice-expression.js";
import type { MonsterDefinition, WeaponDefinition } from "../rules/content-definitions.js";
import type { SealedContent } from "../rules/content-registry.js";
import type { AttackOption, Combatant, ZoneId } from "./combat-state.js";

const freshTurn = { action: true, bonusAction: true, reaction: true, movement: 0 } as const;

// A hero's attack with a weapon (2014 rules): Strength for melee, Dexterity
// for ranged, the better of the two for finesse; heroes are proficient with
// the weapons they carry.
export function heroAttackOption(sheet: CharacterSheet, weapon: WeaponDefinition): AttackOption {
  const str = abilityModifier(sheet.abilityScores.str);
  const dex = abilityModifier(sheet.abilityScores.dex);
  const ability = weapon.range.kind === "ranged" ? dex : weapon.finesse ? Math.max(str, dex) : str;
  return {
    weapon: weapon.id,
    toHit: ability + sheet.proficiencyBonus,
    damage: plus(weapon.damage, ability),
    damageType: weapon.damageType,
    range: weapon.range,
  };
}

export function heroCombatant(sheet: CharacterSheet, content: SealedContent, zoneId: ZoneId, hp: number): Combatant {
  const attacks = sheet.weapons.flatMap((id) => {
    const weapon = content.find(id);
    return weapon?.kind === "item" ? [heroAttackOption(sheet, weapon)] : [];
  });
  return {
    id: sheet.id,
    side: "party",
    source: { kind: "hero", characterId: sheet.id },
    letter: null,
    armorClass: sheet.armorClass,
    maxHp: sheet.maxHp,
    hp,
    speed: sheet.speed,
    initiativeModifier: abilityModifier(sheet.abilityScores.dex),
    attacks,
    traits: [],
    tactic: null,
    fleeBelowHpFraction: null,
    zoneId,
    initiative: null,
    budget: freshTurn,
    dodging: false,
    condition: hp > 0 ? "active" : "unconscious",
    deathSaves: { successes: 0, failures: 0 },
  };
}

export interface MonsterPlacement {
  readonly id: string;
  readonly letter: string | null;
  readonly zoneId: ZoneId;
  readonly npcId: string | null;
  readonly fleeBelowHpFraction: number | null;
}

export function monsterCombatant(monster: MonsterDefinition, content: SealedContent, placement: MonsterPlacement): Combatant {
  const attacks = monster.attacks.flatMap((attack) => {
    const weapon = content.find(attack.weapon);
    if (weapon?.kind !== "item") return [];
    return [{ weapon: weapon.id, toHit: attack.toHit, damage: attack.damage, damageType: weapon.damageType, range: weapon.range }];
  });
  return {
    id: placement.id,
    side: "foes",
    source: { kind: "monster", monsterId: monster.id, npcId: placement.npcId },
    letter: placement.letter,
    armorClass: monster.armorClass,
    maxHp: monster.maxHp,
    hp: monster.maxHp,
    speed: monster.speed,
    initiativeModifier: abilityModifier(monster.abilityScores.dex),
    attacks,
    traits: monster.traits,
    tactic: monster.tactic,
    fleeBelowHpFraction: placement.fleeBelowHpFraction,
    zoneId: placement.zoneId,
    initiative: null,
    budget: freshTurn,
    dodging: false,
    condition: "active",
    deathSaves: { successes: 0, failures: 0 },
  };
}
