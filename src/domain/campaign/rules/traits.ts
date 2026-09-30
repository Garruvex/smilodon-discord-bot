import type { DiceExpression } from "../dice/dice-expression.js";
import type { ContentId } from "./content-id.js";
import type { Ability, DamageType } from "./effects.js";

// What kind of creature a monster is, for the rules that single out undead, fiends and the like.
export const creatureTypes = ["aberration", "beast", "celestial", "construct", "dragon", "elemental", "fey", "fiend", "giant", "humanoid", "monstrosity", "ooze", "plant", "undead"] as const;
export type CreatureType = (typeof creatureTypes)[number];

// Passive rules a creature has, from whatever grants them: armor and shields,
// class features, monster stat blocks. One closed union, so each rule is
// implemented once in the engine and reused by every source (code structure:
// same system, different stats).
export type Trait =
  // Armor: base AC plus Dexterity, capped (null: no cap; 0: heavy armor).
  | { readonly kind: "armor"; readonly baseArmorClass: number; readonly dexterityCap: number | null }
  // Shield, Fighting Style (Defense), and similar flat AC bonuses.
  | { readonly kind: "armorClassBonus"; readonly amount: number }
  // Fighting Style (Dueling): extra damage with a one-handed melee weapon
  // and no other weapon. The milestone 0 heroes carry one melee weapon, so
  // the engine applies it when a hero has exactly one melee weapon.
  | { readonly kind: "meleeDamageBonus"; readonly amount: number }
  // Disciple of Life: healing spells of 1st level or higher restore extra HP.
  | { readonly kind: "healingBonus"; readonly flat: number; readonly perSpellLevel: number }
  // Once per turn, extra damage on a hit with a finesse or ranged weapon when
  // the attack has advantage, or an ally is next to the target. The die
  // count scales with the rogue's level (attack-rules.ts's sneakDice), not
  // carried here, so this is a marker rather than a value.
  | { readonly kind: "sneakAttack" }
  // Advantage on attacks while an ally is engaged with the target.
  | { readonly kind: "packTactics" }
  // Disengage (or Hide) as a bonus action.
  | { readonly kind: "nimbleEscape" }
  // Extra Attack: the Attack action makes this many weapon attacks instead
  // of one (2 for most classes; a Fighter's own later features raise it
  // further). More than one granted source: the highest applies.
  | { readonly kind: "extraAttack"; readonly attacks: number }
  // Multiattack: the Attack action makes these attacks, in this order. An
  // engine-played monster swings each in turn (movement.ts's afterResolution),
  // skipping any that has nothing in reach.
  | { readonly kind: "multiattack"; readonly weapons: readonly ContentId<"item">[] }
  // Cunning Action: Dash or Disengage costs a bonus action instead of the
  // action, when the bonus action is still free (Hide is not modeled).
  | { readonly kind: "cunningAction" }
  // Divine Smite: a melee hit can spend a spell slot for bonus radiant damage.
  | { readonly kind: "divineSmite" }
  // Uncanny Dodge: halves an attack's damage. Simplified: applied
  // automatically whenever available (resolution.ts) rather than offered as
  // a reaction prompt — unlike Shield, it has no cost or downside to weigh,
  // so there is no real choice to ask about, only whether the reaction and
  // the trait are there.
  | { readonly kind: "uncannyDodge" }
  // Wild Shape: may borrow a beast's stat block as a bonus action
  // (engine/combat/wild-shape.ts). A marker; which beasts are offered is
  // computed there, not carried on the trait.
  | { readonly kind: "wildShape" }
  // Half damage of these types (rounded down); zero of these types (immune);
  // double these types (vulnerable). A monster stat block's Damage
  // Resistances/Immunities/Vulnerabilities, e.g. Skeleton's bludgeoning
  // vulnerability. Simplified: the SRD's "nonmagical weapons" qualifier on
  // some resistances is dropped (the engine has no notion of a magic
  // weapon), so those are granted as flat resistance to the damage type.
  // A monster's creature type (Turn Undead, Divine Smite's extra die against undead and fiends).
  | { readonly kind: "creatureType"; readonly type: CreatureType }
  | { readonly kind: "damageResistance"; readonly damageTypes: readonly DamageType[] }
  | { readonly kind: "damageImmunity"; readonly damageTypes: readonly DamageType[] }
  | { readonly kind: "damageVulnerability"; readonly damageTypes: readonly DamageType[] }
  // Never gains these conditions (Skeleton/Zombie's immunity to poisoned; a
  // monster's own immunity list, not a condition's, since only some holders
  // of a given condition are immune to it, e.g. undead but not the living).
  // A spell-shaped ability the holder can use (Bardic Inspiration, Breath Weapon, Lay on Hands): cast like a
  // cantrip from the turn menu, limited by uses (null: at will) that come back on a rest. usesAbility makes the
  // uses the ability modifier (at least 1); ability is what its save DC and attack bonus are built on.
  | {
      readonly kind: "featureSpell";
      readonly spell: ContentId<"spell">;
      readonly ability: Ability;
      readonly uses: number | null;
      // Uses that grow with level: the last entry at or below the holder's level wins over `uses`.
      readonly usesAt?: readonly { readonly level: number; readonly uses: number }[];
      readonly usesAbility?: boolean;
      // A fixed save DC, for an item that casts the spell for its holder (a wand's DC 15).
      readonly saveDc?: number;
      readonly recharge: "shortRest" | "longRest" | "never";
      // Spells that draw on one shared pool of charges (a staff): the pool's name, and how many charges this spell costs.
      readonly pool?: string;
      readonly cost?: number;
    }
  // A flat bonus to saving throws (Ring of Protection, Cloak of Protection).
  | { readonly kind: "saveBonus"; readonly amount: number }
  // The holder's ability score is at least this while the item is carried (Amulet of Health, Belt of Giant Strength).
  | { readonly kind: "abilityScore"; readonly ability: Ability; readonly score: number }
  // Half-Orc Savage Attacks: a melee weapon critical hit rolls one extra damage die.
  | { readonly kind: "savageAttacks" }
  // Brutal Critical: this many more weapon dice on a melee critical hit (they add up across the levels that grant them).
  // Can see in the dark to this many feet (Darkvision); blindsight, tremorsense and truesight count for it too.
  | { readonly kind: "darkvision"; readonly feet: number }
  // Warlock invocation Agonizing Blast: the spellcasting modifier is added to each beam of Eldritch Blast.
  | { readonly kind: "agonizingBlast" }
  // Hunter's Multiattack (Whirlwind Attack): a melee attack also strikes every other foe in melee with the holder, each with its own attack roll.
  | { readonly kind: "whirlwind" }
  // Retaliation (Berserker 10): a creature that damages the holder from close by is struck back, with the holder's reaction.
  | { readonly kind: "retaliation" }
  // Countercharm (Bard 6): friends near the holder, the holder too, have advantage on saves against being frightened or charmed.
  | { readonly kind: "countercharm" }
  // Superior Hunter's Defense (Hunter 15): when damaged, the holder's reaction gives resistance to that damage type until its next turn.
  | { readonly kind: "hunterDefense" }
  // Land's Stride: difficult terrain costs nothing extra to cross.
  | { readonly kind: "landsStride" }
  // Sculpt Spells (School of Evocation): the wizard spares some friends from an evocation area, one more than the spell's level.
  | { readonly kind: "sculptSpells" }
  // Perfect Self (Monk 20): a monk with no ki left regains four when initiative is rolled.
  | { readonly kind: "perfectSelf" }
  // Superior Inspiration (Bard 20): a bard with no Bardic Inspiration left regains one when initiative is rolled.
  | { readonly kind: "superiorInspiration" }
  // Repelling Blast: a creature Eldritch Blast hits is pushed away.
  | { readonly kind: "repellingBlast" }
  // Fighting Style (Archery): a bonus to attack rolls with ranged weapons.
  | { readonly kind: "rangedAttackBonus"; readonly amount: number }
  // Fighting Style (Defense): a bonus to armor class while wearing armor.
  | { readonly kind: "armoredBonus"; readonly amount: number }
  // Halfling Lucky: a natural 1 on an attack roll or saving throw is rolled again, and the new roll is used.
  | { readonly kind: "lucky" }
  // Fighter's Indomitable: a failed saving throw is rolled again (its uses are counted like a monster's Legendary Resistance).
  | { readonly kind: "indomitable" }
  // Barbarian's Feral Instinct: advantage on initiative rolls.
  | { readonly kind: "feralInstinct" }
  // Champion's Survivor: at the start of its turn, at half its hit points or fewer (and above 0), regains 5 plus its Constitution modifier.
  | { readonly kind: "survivor" }
  // Elusive (Rogue 18): no attack roll has advantage against the holder unless it is incapacitated.
  | { readonly kind: "elusive" }
  // Aura of Courage and Aura of Devotion (Paladin 10, 7): the holder and its conscious allies in its zone cannot gain these conditions.
  | { readonly kind: "auraOfImmunity"; readonly conditions: readonly ContentId<"condition">[] }
  // Empowered Evocation (Wizard 10): the spellcasting modifier is added to one damage roll of an evocation spell.
  | { readonly kind: "empoweredEvocation" }
  // Supreme Healing (Life Cleric 17): healing spells restore the most their dice can give.
  | { readonly kind: "supremeHealing" }
  // Draconic Resilience: armor class 13 plus Dexterity with no armor (a flat bonus to the unarmored base).
  | { readonly kind: "unarmoredBonus"; readonly amount: number }
  // Elemental Affinity (Draconic sorcerer 6): the spellcasting modifier is added to one damage roll of a spell that deals this type.
  | { readonly kind: "elementalAffinity"; readonly damageType: DamageType }
  // Blood Frenzy: advantage on melee attack rolls against a creature that is missing hit points.
  | { readonly kind: "bloodFrenzy" }
  // Sunlight Sensitivity: disadvantage on attack rolls while the creature, or its target, is in a zone lit as bright (explicitly: a zone with no lighting named counts for nothing).
  | { readonly kind: "sunlightSensitivity" }
  // Blessed Healer (Life Cleric 6): healing another creature with a spell also heals the caster, 2 plus the spell's level.
  | { readonly kind: "blessedHealer" }
  // Stroke of Luck (Rogue 20): once per short rest, a missed attack roll hits instead.
  | { readonly kind: "strokeOfLuck" }
  // Fast Hands (Thief 3): drinking a potion or using an object takes a bonus action.
  | { readonly kind: "fastHands" }
  // Beast Spells (Druid 18): may cast spells while in a beast shape.
  | { readonly kind: "beastSpells" }
  // Archdruid (Druid 20): Wild Shape has no limit on its uses.
  | { readonly kind: "unlimitedWildShape" }
  // Vanish (Ranger 14): Hiding takes a bonus action.
  | { readonly kind: "quickHide" }
  // Foe Slayer (Ranger 20): the Wisdom modifier on weapon damage.
  | { readonly kind: "foeSlayer" }
  // Charge, Pounce, Trampling Charge: a melee hit after moving at least this far in the turn deals extra damage (of the weapon's type when none is named)
  // and the target makes a Strength save or is knocked prone.
  | { readonly kind: "charge"; readonly feet: number; readonly dc: number; readonly extra?: DiceExpression; readonly damageType?: DamageType }
  // Cutting Words (College of Lore): a Bardic Inspiration use and the reaction take the die's average off a foe's attack roll within 60 feet, when that turns a hit into a miss.
  | { readonly kind: "cuttingWords" }
  // Fighting Style (Protection): when a creature attacks another one standing beside the holder, the holder's reaction gives that attack disadvantage. The shield the SRD asks for is not checked.
  | { readonly kind: "protectionStyle" }
  // Divine Strike (Cleric 8): a weapon hit deals 1d8 more radiant damage (2d8 from level 14).
  | { readonly kind: "divineStrike" }
  // Dark One's Blessing (Fiend warlock): reducing a hostile creature to 0 hit points gives temporary hit points (Charisma modifier plus level).
  | { readonly kind: "darkOnesBlessing" }
  // Potent Cantrip (Wizard 6): a creature that saves against the wizard's damaging cantrip still takes half the damage.
  | { readonly kind: "potentCantrip" }
  // Deflect Missiles (Monk 3): a ranged weapon hit is reduced by 1d10 plus Dexterity modifier plus level (played at the die's average), using the reaction.
  | { readonly kind: "deflectMissiles" }
  // Indomitable Might (Barbarian 18): a Strength check total is at least the Strength score.
  | { readonly kind: "indomitableMight" }
  | { readonly kind: "brutalCritical"; readonly dice: number }
  // Evasion: a Dexterity save that would halve the damage takes none on a success, and half on a failure.
  | { readonly kind: "evasion" }
  // Aura of Protection: allies in the paladin's zone (and the paladin) add this to their saving throws. The bonus is the holder's Charisma modifier, filled in when the hero joins a fight.
  | { readonly kind: "auraOfProtection"; readonly bonus: number }
  // Improved Divine Smite: 1d8 more radiant damage on every melee weapon hit.
  | { readonly kind: "improvedDivineSmite" }
  // Half-Orc Relentless Endurance: once per long rest, damage that would drop the holder to 0 HP leaves 1 HP instead.
  | { readonly kind: "relentlessEndurance" }
  | { readonly kind: "conditionImmunity"; readonly conditions: readonly ContentId<"condition">[] }
  // Advantage on saving throws against being given one of these conditions (Fey
  // Ancestry, Brave), against these damage types (Dwarven Resilience), or against
  // spells and other magic (Gnome Cunning); abilities narrows it to some saves.
  | {
      readonly kind: "saveAdvantage";
      readonly conditions?: readonly ContentId<"condition">[];
      readonly damageTypes?: readonly DamageType[];
      readonly magic?: boolean;
      readonly abilities?: readonly Ability[];
      // Against everything (Danger Sense).
      readonly always?: boolean;
    }
  // Barbarian and Monk Unarmored Defense: with no armor, AC is 10 + Dexterity + this ability's modifier.
  | { readonly kind: "unarmoredDefense"; readonly ability: Ability }
  // Fast Movement, Unarmored Movement.
  | { readonly kind: "speedBonus"; readonly amount: number }
  // Hunter's Colossus Slayer: once per turn, 1d8 extra damage to a creature that is missing hit points.
  | { readonly kind: "colossusSlayer" }
  // Arcane Recovery and Natural Recovery: on a short rest, get spell slots back once a day (combined level up to half the holder's level, rounded up).
  | { readonly kind: "slotRecovery"; readonly feature: ContentId<"feature"> }
  // Champion's Improved Critical: a natural roll of this or higher on an
  // attack is a critical hit, not just a natural 20. The lowest of any held
  // wins (nothing lowers it below 20 by default).
  | { readonly kind: "expandedCritRange"; readonly threshold: number }
  // A breath weapon and the like: every foe within range makes a saving throw,
  // taking the damage (or half of it, when halfOnSave) as the Attack action's
  // replacement. The SRD's "recharge 5-6" is played deterministically: after use
  // it comes back once its cooldown, in the monster's own turns, has run out.
  | {
      readonly kind: "areaAttack";
      // The item id that names it ("item:fire-breath").
      readonly weapon: ContentId<"item">;
      readonly ability: Ability;
      readonly dc: number;
      // What a failed save costs: damage (half of it on a save when halfOnSave), and/or a condition.
      readonly damage?: DiceExpression;
      readonly damageType?: DamageType;
      readonly condition?: ContentId<"condition">;
      readonly halfOnSave: boolean;
      // Feet: every foe this close is caught.
      readonly range: number;
      readonly cooldown: number;
      // An aura (Frightful Presence) is used as part of the action, not in place of it.
      readonly free?: boolean;
      // Used only as a legendary action (a dragon's Wing Attack), never on the monster's own turn.
      readonly legendary?: boolean;
    }
  // Death Burst: when the holder dies, everyone else in its zone makes the saving throw (a zone is a place, so the
  // SRD's five or ten feet all mean the same thing). Fields are those of an area attack.
  | {
      readonly kind: "deathBurst";
      readonly weapon: ContentId<"item">;
      readonly ability: Ability;
      readonly dc: number;
      readonly damage?: DiceExpression;
      readonly damageType?: DamageType;
      readonly condition?: ContentId<"condition">;
      readonly halfOnSave: boolean;
    }
  // Regains these hit points at the start of its turn, unless it took damage of
  // one of the listed types since its last turn.
  | { readonly kind: "regeneration"; readonly amount: number; readonly blockedBy: readonly DamageType[] }
  // Turns this many failed saving throws a day into successes.
  | { readonly kind: "legendaryResistance"; readonly uses: number }
  // Legendary actions: after another creature's turn, spends some of its actions per round (renewed at
  // the start of its own turn) on one of these attacks, each costing this many.
  | { readonly kind: "legendaryActions"; readonly uses: number; readonly options: readonly { readonly weapon: ContentId<"item">; readonly cost: number }[] };

// Where a monster's remaining Legendary Resistance is counted (resources.featureUses).
// Where an innate or spell-shaped ability's uses left are counted (resources.featureUses).
// Spell-shaped abilities that draw on one pool of uses (Turn Undead and Preserve Life are both the cleric's one Channel Divinity).
const sharedUses: Readonly<Record<string, string>> = { "spell:turn-undead": "spell:preserve-life" };
export const innateUseKey = (spellId: string): string => `innate:${sharedUses[spellId] ?? spellId}`;

export function creatureTypeOf(traits: readonly Trait[]): CreatureType | null {
  for (const trait of traits) if (trait.kind === "creatureType") return trait.type;
  return null;
}

// Where a hero's Relentless Endurance use is counted (resources.featureUses).
export const relentlessEnduranceKey = "trait:relentless-endurance";
// Relentless Rage (Barbarian 11): where its use is counted.
export const relentlessRageKey = "feature:relentless-rage";
export const legendaryResistanceKey = "trait:legendary-resistance";
// A Death Burst still to go off (1) or gone off (0).
export const deathBurstKey = "trait:death-burst";
export const indomitableKey = "feature:indomitable";
// And its legendary actions left this round.
export const legendaryActionsKey = "trait:legendary-actions";

export type AreaAttack = Extract<Trait, { readonly kind: "areaAttack" }>;

export type TraitKind = Trait["kind"];

// How many weapon attacks the Attack action makes: 1, or more from Extra Attack
// (the highest granted source) or Multiattack.
export function attacksPerAction(traits: readonly Trait[]): number {
  return traits.reduce((most, trait) => {
    if (trait.kind === "extraAttack") return Math.max(most, trait.attacks);
    if (trait.kind === "multiattack") return Math.max(most, trait.weapons.length);
    return most;
  }, 1);
}

// The multiplier this creature's traits apply to damage of this type:
// resistance and vulnerability to the same type cancel out per the SRD, and
// immunity wins over either. Applied before rounding (damage.ts floors it).
export function damageMultiplier(traits: readonly Trait[], damageType: DamageType): number {
  if (traits.some((trait) => trait.kind === "damageImmunity" && trait.damageTypes.includes(damageType))) return 0;
  const resistant = traits.some((trait) => trait.kind === "damageResistance" && trait.damageTypes.includes(damageType));
  const vulnerable = traits.some((trait) => trait.kind === "damageVulnerability" && trait.damageTypes.includes(damageType));
  if (resistant === vulnerable) return 1;
  return resistant ? 0.5 : 2;
}

// Whether this creature's traits make it immune to gaining this specific
// condition (checked where a condition is about to be applied, not where its
// modifiers are read — an immune creature simply never receives the effect).
export function isImmuneToCondition(traits: readonly Trait[], conditionId: ContentId<"condition">): boolean {
  return traits.some((trait) => trait.kind === "conditionImmunity" && trait.conditions.includes(conditionId));
}

// What a saving throw is against, for the advantage the traits above give.
export interface SaveContext {
  readonly conditions: readonly ContentId<"condition">[];
  readonly damageTypes: readonly DamageType[];
  readonly magic: boolean;
}

export function hasSaveAdvantage(traits: readonly Trait[], ability: Ability, context: SaveContext): boolean {
  return traits.some(
    (trait) =>
      trait.kind === "saveAdvantage" &&
      (trait.abilities === undefined || trait.abilities.includes(ability)) &&
      (trait.always === true ||
        (trait.conditions?.some((condition) => context.conditions.includes(condition)) ?? false) ||
        (trait.damageTypes?.some((damageType) => context.damageTypes.includes(damageType)) ?? false) ||
        (trait.magic === true && context.magic)),
  );
}

// The lowest natural roll that lands a critical hit for this creature's own
// attacks (Champion's Improved Critical lowers it to 19; nothing here raises
// it, so the default is the ordinary 20).
export function critThreshold(traits: readonly Trait[]): number {
  return traits.reduce((lowest, trait) => (trait.kind === "expandedCritRange" ? Math.min(lowest, trait.threshold) : lowest), 20);
}
