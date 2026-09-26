import { abilityModifier, savingThrowModifier, type CharacterSheet } from "../character/character-sheet.js";
import { plus } from "../dice/dice-expression.js";
import { traitsOf, type MonsterDefinition, type WeaponDefinition } from "../rules/content-definitions.js";
import type { SealedContent } from "../rules/content-registry.js";
import { abilities, type Ability } from "../rules/effects.js";
import type { Trait } from "../rules/traits.js";
import type { AttackOption, Combatant, CombatResources, ZoneId } from "./combat-state.js";

const freshTurn = { action: true, bonusAction: true, reaction: true, movement: 0 } as const;

// What a hero brings into a fight from outside it.
export interface HeroStatus {
  readonly hp: number;
  readonly resources: CombatResources;
  // Unspent Hit Dice; absent means all of them (the hero's level).
  readonly hitDice?: number;
}

// Everything the hero's equipment and features grant, as one list.
export function heroTraits(sheet: CharacterSheet, content: SealedContent): readonly Trait[] {
  return [...sheet.equipment, ...sheet.features].flatMap((id) => {
    const definition = content.find(id);
    return definition === undefined ? [] : traitsOf(definition);
  });
}

// 2014 rules: armor sets the base (Dexterity capped by armor type), with no
// armor it is 10 + Dexterity; shields and similar traits add on top.
export function armorClassFrom(traits: readonly Trait[], dexterityModifier: number): number {
  let base = 10 + dexterityModifier;
  let bonus = 0;
  for (const trait of traits) {
    if (trait.kind === "armor") {
      const dex = trait.dexterityCap === null ? dexterityModifier : Math.min(dexterityModifier, trait.dexterityCap);
      base = trait.baseArmorClass + dex;
    }
    if (trait.kind === "armorClassBonus") bonus += trait.amount;
  }
  return base + bonus;
}

// A hero's attack with a weapon: Strength for melee, Dexterity for ranged,
// the better of the two for finesse; heroes are proficient with the weapons
// they carry. Dueling adds damage when it is the hero's only melee weapon.
export function heroAttackOption(sheet: CharacterSheet, weapon: WeaponDefinition, traits: readonly Trait[], meleeWeapons: number): AttackOption {
  const str = abilityModifier(sheet.abilityScores.str);
  const dex = abilityModifier(sheet.abilityScores.dex);
  const ability = weapon.range.kind === "ranged" ? dex : weapon.finesse ? Math.max(str, dex) : str;
  const dueling =
    weapon.range.kind === "melee" && meleeWeapons === 1
      ? traits.reduce((sum, trait) => sum + (trait.kind === "meleeDamageBonus" ? trait.amount : 0), 0)
      : 0;
  return {
    weapon: weapon.id,
    toHit: ability + sheet.proficiencyBonus,
    damage: plus(weapon.damage, ability + dueling),
    damageType: weapon.damageType,
    range: weapon.range,
    finesse: weapon.finesse || weapon.range.kind === "ranged",
    onHit: [],
  };
}

export function defaultHeroResources(sheet: CharacterSheet, content: SealedContent): CombatResources {
  const featureUses: Record<string, number> = {};
  for (const id of sheet.features) {
    const feature = content.find(id);
    if (feature?.kind === "feature" && feature.action !== null) featureUses[id] = feature.action.uses.count;
  }
  return { spellSlots: { ...(sheet.spellcasting?.slots ?? {}) }, featureUses };
}

export function heroCombatant(sheet: CharacterSheet, content: SealedContent, zoneId: ZoneId, status: HeroStatus): Combatant {
  const traits = heroTraits(sheet, content);
  const weapons = sheet.equipment.flatMap((id) => {
    const item = content.find(id);
    return item?.kind === "item" && item.itemType === "weapon" ? [item] : [];
  });
  const meleeWeapons = weapons.filter((weapon) => weapon.range.kind === "melee").length;
  const dex = abilityModifier(sheet.abilityScores.dex);
  const saves = Object.fromEntries(abilities.map((ability) => [ability, savingThrowModifier(sheet, ability)])) as Record<Ability, number>;
  const casting = sheet.spellcasting;
  const castingModifier = casting === null ? 0 : abilityModifier(sheet.abilityScores[casting.ability]);
  return {
    id: sheet.id,
    side: "party",
    source: { kind: "hero", characterId: sheet.id },
    letter: null,
    level: sheet.level,
    armorClass: armorClassFrom(traits, dex),
    maxHp: sheet.maxHp,
    hp: status.hp,
    speed: sheet.speed,
    initiativeModifier: dex,
    saves,
    attacks: weapons.map((weapon) => heroAttackOption(sheet, weapon, traits, meleeWeapons)),
    spellcasting:
      casting === null
        ? null
        : {
            attackBonus: sheet.proficiencyBonus + castingModifier,
            saveDc: 8 + sheet.proficiencyBonus + castingModifier,
            modifier: castingModifier,
            spells: casting.spells,
          },
    features: sheet.features,
    resources: status.resources,
    traits,
    tactic: null,
    fleeBelowHpFraction: null,
    zoneId,
    initiative: null,
    budget: freshTurn,
    dodging: false,
    disengaged: false,
    sneakAttackUsed: false,
    condition: status.hp > 0 ? "active" : "stable",
    conditions: [],
    effects: [],
    concentration: null,
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
  const attacks = monster.attacks.flatMap((attack): AttackOption[] => {
    const weapon = content.find(attack.weapon);
    if (weapon?.kind !== "item" || weapon.itemType !== "weapon") return [];
    const range = attack.range ?? weapon.range;
    return [
      {
        weapon: weapon.id,
        toHit: attack.toHit,
        damage: attack.damage,
        damageType: weapon.damageType,
        range,
        finesse: weapon.finesse || range.kind === "ranged",
        onHit: attack.onHit ?? [],
      },
    ];
  });
  const saves = Object.fromEntries(abilities.map((ability) => [ability, abilityModifier(monster.abilityScores[ability])])) as Record<Ability, number>;
  return {
    id: placement.id,
    side: "foes",
    source: { kind: "monster", monsterId: monster.id, npcId: placement.npcId },
    letter: placement.letter,
    level: 0,
    armorClass: monster.armorClass,
    maxHp: monster.maxHp,
    hp: monster.maxHp,
    speed: monster.speed,
    initiativeModifier: abilityModifier(monster.abilityScores.dex),
    saves,
    attacks,
    spellcasting: null,
    features: [],
    resources: { spellSlots: {}, featureUses: {} },
    traits: monster.traits,
    tactic: monster.tactic,
    fleeBelowHpFraction: placement.fleeBelowHpFraction,
    zoneId: placement.zoneId,
    initiative: null,
    budget: freshTurn,
    dodging: false,
    disengaged: false,
    sneakAttackUsed: false,
    condition: "active",
    conditions: [],
    effects: [],
    concentration: null,
    deathSaves: { successes: 0, failures: 0 },
  };
}
