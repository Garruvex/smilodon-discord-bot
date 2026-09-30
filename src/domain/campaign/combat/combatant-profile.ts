import { abilityModifier, savingThrowModifier, type CharacterSheet } from "../character/character-sheet.js";
import { spellbookOf } from "../character/spell-access.js";
import { plus } from "../dice/dice-expression.js";
import { traitsOf, type MonsterDefinition, type MonsterSpellcasting, type WeaponDefinition } from "../rules/content-definitions.js";
import { innateUseKey } from "../magic/spell-rules.js";
import type { SealedContent } from "../rules/content-registry.js";
import { abilities, type Ability } from "../rules/effects.js";
import { deathBurstKey, legendaryActionsKey, legendaryResistanceKey, type Trait } from "../rules/traits.js";
import type { HeroStatus } from "../character/hero-status.js";
import { armorSpeedPenalty, isWorn } from "../engine/gear.js";
import type { AttackOption, Combatant, CombatSpellcasting, ZoneId } from "./combat-state.js";

const freshTurn = { action: true, bonusAction: true, reaction: true, movement: 0, attacksLeft: 1, bonusSpellCast: false } as const;

// Hero status and worn gear belong to Character and Inventory; they are re-exported for callers that build combatants.
export { defaultHeroResources, type HeroStatus } from "../character/hero-status.js";
export { isWorn } from "../engine/gear.js";

// Everything the hero's worn gear and features grant, as one list. Equipment
// IDs are deduplicated first: only one of each item can be worn regardless of
// how many the sheet lists (a spare shield in the pack), so isWorn's by-ID
// check must be asked once per distinct item, not once per inventory entry —
// otherwise a second copy of a worn shield or armor would count its bonus twice.
export function heroTraits(sheet: CharacterSheet, content: SealedContent): readonly Trait[] {
  let attuned = 0;
  const worn = [...new Set(sheet.equipment)].filter((id) => {
    if (!isWorn(sheet, content, id)) return false;
    // A hero attunes to at most three items.
    const definition = content.find(id);
    if (definition?.kind !== "item" || definition.itemType !== "magic" || !definition.attunement) return true;
    attuned += 1;
    return attuned <= 3;
  });
  const raceTraits = sheet.race === undefined ? [] : traitsOf(content.get(sheet.race));
  const chaModifier = abilityModifier(sheet.abilityScores.cha);
  return [
    ...raceTraits,
    ...[...worn, ...sheet.features].flatMap((id) => {
      const definition = content.find(id);
      return definition === undefined ? [] : traitsOf(definition);
    }),
  ].map((trait): Trait => (trait.kind === "auraOfProtection" ? { ...trait, bonus: Math.max(1, chaModifier) } : trait));
}

// 2014 rules: armor sets the base (Dexterity capped by armor type), with no
// armor it is 10 + Dexterity; shields and similar traits add on top.
export function armorClassFrom(traits: readonly Trait[], dexterityModifier: number, unarmoredModifier = 0): number {
  const armored = traits.some((trait) => trait.kind === "armor");
  let base = 10 + dexterityModifier + (armored ? 0 : unarmoredModifier);
  let bonus = 0;
  for (const trait of traits) {
    if (trait.kind === "armor") {
      const dex = trait.dexterityCap === null ? dexterityModifier : Math.min(dexterityModifier, trait.dexterityCap);
      base = trait.baseArmorClass + dex;
    }
    if (trait.kind === "armorClassBonus") bonus += trait.amount;
    if (trait.kind === "armoredBonus" && armored) bonus += trait.amount;
    if (trait.kind === "unarmoredBonus" && !armored) bonus += trait.amount;
  }
  return base + bonus;
}

// The ability modifier Unarmored Defense adds (Constitution for a barbarian, Wisdom for a monk), if the hero has it.
export function unarmoredModifier(traits: readonly Trait[], scores: CharacterSheet["abilityScores"]): number {
  return traits.reduce((best, trait) => (trait.kind === "unarmoredDefense" ? Math.max(best, abilityModifier(scores[trait.ability])) : best), 0);
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
    toHit: ability + sheet.proficiencyBonus + (weapon.enchantment ?? 0) + (weapon.range.kind === "ranged" ? traits.reduce((sum, trait) => sum + (trait.kind === "rangedAttackBonus" ? trait.amount : 0), 0) : 0),
    damage: plus(weapon.damage, ability + dueling + (weapon.enchantment ?? 0)),
    damageType: weapon.damageType,
    range: weapon.range,
    finesse: weapon.finesse || weapon.range.kind === "ranged",
    onHit: weapon.onHit ?? [],
  };
}

// Magic that sets an ability score (a Belt of Giant Strength) applies to everything the hero rolls in a fight.
function withMagicScores(sheet: CharacterSheet, traits: readonly Trait[]): CharacterSheet {
  const scores = { ...sheet.abilityScores };
  for (const trait of traits) if (trait.kind === "abilityScore") scores[trait.ability] = Math.max(scores[trait.ability], trait.score);
  return { ...sheet, abilityScores: scores };
}

// A hero's spellcasting: their class's, plus any spell-shaped abilities their traits give (cast as innate spells).
function heroSpellcasting(sheet: CharacterSheet, content: SealedContent, traits: readonly Trait[], castingModifier: number | null): CombatSpellcasting | null {
  const granted = traits.flatMap((trait) => (trait.kind === "featureSpell" ? [trait] : []));
  const base = sheet.proficiencyBonus;
  if (granted.length === 0) {
    return castingModifier === null ? null : { attackBonus: base + castingModifier, saveDc: 8 + base + castingModifier, modifier: castingModifier, spells: spellbookOf(sheet, content) };
  }
  const first = granted[0];
  const modifier = castingModifier ?? abilityModifier(sheet.abilityScores[first?.ability ?? "cha"]);
  const innate: Record<string, number | null> = {};
  const saveDcs: Record<string, number> = {};
  const pools: Record<string, { readonly key: string; readonly cost: number }> = {};
  for (const trait of granted) {
    const mod = abilityModifier(sheet.abilityScores[trait.ability]);
    const atLevel = trait.usesAt?.filter((step) => step.level <= sheet.level).at(-1)?.uses;
    innate[trait.spell] = trait.usesAbility === true ? Math.max(1, mod) : (atLevel ?? trait.uses);
    saveDcs[trait.spell] = trait.saveDc ?? 8 + base + mod;
    if (trait.pool !== undefined) pools[trait.spell] = { key: trait.pool.startsWith("feature:") ? trait.pool : `pool:${trait.pool}`, cost: trait.cost ?? 1 };
  }
  return {
    attackBonus: base + modifier,
    saveDc: 8 + base + modifier,
    modifier,
    spells: [...(castingModifier === null ? [] : spellbookOf(sheet, content)), ...granted.map((trait) => trait.spell)],
    innate,
    saveDcs,
    ...(Object.keys(pools).length === 0 ? {} : { pools }),
  };
}

export function heroCombatant(base: CharacterSheet, content: SealedContent, zoneId: ZoneId, status: HeroStatus): Combatant {
  const traits = heroTraits(base, content);
  const sheet = withMagicScores(base, traits);
  const saveBonus = traits.reduce((sum, trait) => sum + (trait.kind === "saveBonus" ? trait.amount : 0), 0);
  // Pact of the Blade: a weapon of the warlock's own, besides whatever they carry.
  const pact = sheet.features.includes("feature:pact-of-the-blade") ? content.find("item:pact-blade") : undefined;
  const weapons = [...sheet.equipment, ...(pact === undefined ? [] : [pact.id])].flatMap((id) => {
    const item = content.find(id);
    return item?.kind === "item" && item.itemType === "weapon" ? [item] : [];
  });
  const meleeWeapons = weapons.filter((weapon) => weapon.range.kind === "melee").length;
  const dex = abilityModifier(sheet.abilityScores.dex);
  const saves = Object.fromEntries(abilities.map((ability) => [ability, savingThrowModifier(sheet, ability) + saveBonus])) as Record<Ability, number>;
  const casting = sheet.spellcasting;
  const castingModifier = casting === null ? 0 : abilityModifier(sheet.abilityScores[casting.ability]);
  return {
    id: sheet.id,
    side: "party",
    source: { kind: "hero", characterId: sheet.id },
    letter: null,
    level: sheet.level,
    armorClass: armorClassFrom(traits, dex, unarmoredModifier(traits, sheet.abilityScores)),
    maxHp: sheet.maxHp,
    hp: status.hp,
    // Armor worn under its Strength requirement (heavy armor a hero isn't
    // strong enough for) costs 10 feet of speed.
    speed: Math.max(0, sheet.speed - armorSpeedPenalty(sheet, content) + traits.reduce((sum, trait) => sum + (trait.kind === "speedBonus" ? trait.amount : 0), 0)),
    initiativeModifier: dex,
    saves,
    attacks: weapons.map((weapon) => heroAttackOption(sheet, weapon, traits, meleeWeapons)),
    spellcasting: heroSpellcasting(sheet, content, traits, casting === null ? null : castingModifier),
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
    exhaustion: status.exhaustion ?? 0,
    wildShapeOriginal: null,
    cooldowns: {},
    regenBlocked: false,
    legendaryTurn: -1,
    condition: status.hp > 0 ? "active" : "stable",
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

// A monster stat block's attacks as AttackOptions, resolving each one's
// weapon reference. Shared by monsterCombatant and Wild Shape (engine/combat/
// wild-shape.ts), which borrows a beast's whole stat block for a hero.
export function monsterAttackOptions(monster: MonsterDefinition, content: SealedContent): readonly AttackOption[] {
  return monster.attacks.flatMap((attack): AttackOption[] => {
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
}

// A monster begins the fight with its legendary actions for the round.
function legendaryActionUses(traits: readonly Trait[]): Readonly<Record<string, number>> {
  const uses = traits.reduce((most, trait) => (trait.kind === "legendaryActions" ? Math.max(most, trait.uses) : most), 0);
  return uses > 0 ? { [legendaryActionsKey]: uses } : {};
}

// A monster begins with its full Legendary Resistance.
function legendaryResistances(traits: readonly Trait[]): Readonly<Record<string, number>> {
  const uses = traits.reduce((sum, trait) => sum + (trait.kind === "legendaryResistance" ? trait.uses : 0), 0);
  return uses > 0 ? { [legendaryResistanceKey]: uses } : {};
}

// A monster with a Death Burst begins with it still to go off.
function deathBursts(traits: readonly Trait[]): Readonly<Record<string, number>> {
  return traits.some((trait) => trait.kind === "deathBurst") ? { [deathBurstKey]: 1 } : {};
}

function monsterSpellcasting(casting: MonsterSpellcasting): CombatSpellcasting {
  return {
    attackBonus: casting.attackBonus,
    saveDc: casting.saveDc,
    modifier: casting.modifier,
    spells: [...casting.spells, ...casting.innate.map((entry) => entry.spell)],
    casterLevel: casting.casterLevel,
    innate: Object.fromEntries(casting.innate.map((entry) => [entry.spell, entry.perDay])),
  };
}

// Innate spells cast a number of times a day begin with all of them.
function innateUses(casting: MonsterSpellcasting | undefined): Readonly<Record<string, number>> {
  return Object.fromEntries((casting?.innate ?? []).flatMap((entry) => (entry.perDay === null ? [] : [[innateUseKey(entry.spell), entry.perDay] as const])));
}

export function monsterCombatant(monster: MonsterDefinition, content: SealedContent, placement: MonsterPlacement): Combatant {
  const attacks = monsterAttackOptions(monster, content);
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
    spellcasting: monster.spellcasting === undefined ? null : monsterSpellcasting(monster.spellcasting),
    features: [],
    resources: { spellSlots: { ...(monster.spellcasting?.slots ?? {}) }, pactSlots: {}, featureUses: { ...legendaryResistances(monster.traits), ...legendaryActionUses(monster.traits), ...deathBursts(monster.traits), ...innateUses(monster.spellcasting) } },
    traits: monster.traits,
    tactic: monster.tactic,
    fleeBelowHpFraction: placement.fleeBelowHpFraction,
    zoneId: placement.zoneId,
    initiative: null,
    budget: freshTurn,
    dodging: false,
    disengaged: false,
    sneakAttackUsed: false,
    exhaustion: 0,
    wildShapeOriginal: null,
    cooldowns: {},
    regenBlocked: false,
    legendaryTurn: -1,
    condition: "active",
    effects: [],
    concentration: null,
    deathSaves: { successes: 0, failures: 0 },
  };
}
