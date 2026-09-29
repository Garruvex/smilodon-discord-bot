import { defineFeature, type FeatureDefinition } from "../../../rules/content-definitions.js";

// Level 2, 3, 5, 11 and 20 class features (SRD 5.1, Classes), granted
// automatically as a hero levels up (content/srd-5.1/classes.ts's
// levelFeatures). Extra Attack, Cunning Action, Divine Smite, Uncanny Dodge
// and Champion's Improved Critical are mechanical (traits, read where an
// attack, a Dash/Disengage, or damage is declared); the rest are narrative
// only, same treatment as Thieves' Cant and the level-1 roster's narrative
// features. Wild Shape is mechanical too, but is its own thing
// (engine/combat/wild-shape.ts), not a trait, since it swaps the hero's
// whole stat block rather than reading one passively.
// Levels this doesn't reach are out of scope for now.
const source = "SRD 5.1";

const narrative = (name: string): FeatureDefinition => defineFeature({ id: `feature:${name}`, source, traits: [], action: null });

// Fighter, Barbarian, Paladin, Ranger and Monk all gain this at level 5.
export const extraAttack = defineFeature({ id: "feature:extra-attack", source, traits: [{ kind: "extraAttack", attacks: 2 }], action: null });
// Only the Fighter goes on to a third attack at 11 and a fourth at 20.
export const extraAttack2 = defineFeature({ id: "feature:extra-attack-2", source, traits: [{ kind: "extraAttack", attacks: 3 }], action: null });
export const extraAttack3 = defineFeature({ id: "feature:extra-attack-3", source, traits: [{ kind: "extraAttack", attacks: 4 }], action: null });

// Hide is not modeled, so only Dash and Disengage move to the bonus action.
export const cunningAction = defineFeature({ id: "feature:cunning-action", source, traits: [{ kind: "cunningAction" }], action: null });
export const uncannyDodge = defineFeature({ id: "feature:uncanny-dodge", source, traits: [{ kind: "uncannyDodge" }], action: null });
// Preserve Life stands for the cleric's Channel Divinity: one healing of 5 hit points per level, once per short rest.
// Turn Undead shares its one use.
export const channelDivinity = defineFeature({
  id: "feature:channel-divinity",
  source,
  traits: [
    { kind: "featureSpell", spell: "spell:preserve-life", ability: "wis", uses: 1, recharge: "shortRest" },
    { kind: "featureSpell", spell: "spell:turn-undead", ability: "wis", uses: 1, recharge: "shortRest" },
  ],
  action: null,
});
// Indomitable: 1 use at level 9, 2 at 13, 3 at 17; a failed saving throw is rolled again.
export const indomitable = defineFeature({
  id: "feature:indomitable",
  source,
  traits: [{ kind: "indomitable" }],
  action: null,
  resource: { count: 1, perLevel: (level) => (level >= 17 ? 3 : level >= 13 ? 2 : 1), recharge: "longRest" },
});
export const superiorCritical = defineFeature({ id: "feature:superior-critical", source, traits: [{ kind: "expandedCritRange", threshold: 18 }], action: null });
const brutalCritical = (suffix: string): FeatureDefinition => defineFeature({ id: `feature:brutal-critical${suffix}`, source, traits: [{ kind: "brutalCritical", dice: 1 }], action: null });
export const evasion = defineFeature({ id: "feature:evasion", source, traits: [{ kind: "evasion" }], action: null });
// The bonus is filled in from the holder's Charisma modifier (combat/combatant-profile.ts).
export const auraOfProtection = defineFeature({ id: "feature:aura-of-protection", source, traits: [{ kind: "auraOfProtection", bonus: 1 }], action: null });
// The SRD's aura also covers allies; here it protects the paladin.
export const auraOfCourage = defineFeature({ id: "feature:aura-of-courage", source, traits: [{ kind: "conditionImmunity", conditions: ["condition:frightened"] }], action: null });
export const improvedDivineSmite = defineFeature({ id: "feature:improved-divine-smite", source, traits: [{ kind: "improvedDivineSmite" }], action: null });
export const purityOfBody = defineFeature({
  id: "feature:purity-of-body",
  source,
  traits: [{ kind: "damageImmunity", damageTypes: ["poison"] }, { kind: "conditionImmunity", conditions: ["condition:poisoned"] }],
  action: null,
});
// A monk's Unarmored Movement grows by 5 feet at levels 6, 10, 14 and 18.
const unarmoredMovementGrowth = (level: number): FeatureDefinition => defineFeature({ id: `feature:unarmored-movement-${level}`, source, traits: [{ kind: "speedBonus", amount: 5 }], action: null });
export const jackOfAllTrades = narrative("jack-of-all-trades");
export const wildShape = defineFeature({ id: "feature:wild-shape", source, traits: [{ kind: "wildShape" }], action: null });
export const divineSmite = defineFeature({ id: "feature:divine-smite", source, traits: [{ kind: "divineSmite" }], action: null });
export const fontOfMagic = narrative("font-of-magic");
export const eldritchInvocations = narrative("eldritch-invocations");
// Champion (Fighter 3): Improved Critical, a real 19-20 crit range
// (dice/d20-test.ts's critThreshold). Remarkable Athlete and Additional
// Fighting Style are not modeled (a skill-check bonus system and a second
// fighting-style slot, neither of which exists here).
export const champion = defineFeature({ id: "feature:champion", source, traits: [{ kind: "expandedCritRange", threshold: 19 }], action: null });
// Thief (Rogue 3): narrative. Fast Hands overlaps with Cunning Action (no
// item-use action to spend it on); Second-Story Work needs a climbing/
// jumping rule the engine doesn't have.
export const thief = narrative("thief");
// Path of the Berserker (Barbarian 3): narrative. Frenzy (an extra attack
// while raging) and Mindless Rage need Rage itself to be a mechanic first
// (feature:rage is narrative-only, like Thieves' Cant).
// Frenzy is an extra melee attack as a bonus action; the SRD asks for a raging barbarian, which is not checked.
// Mindless Rage (level 6) is not modeled.
export const pathOfTheBerserker = defineFeature({
  id: "feature:path-of-the-berserker",
  source,
  traits: [],
  action: { cost: "bonusAction", uses: { count: 99, recharge: "shortRest" }, plan: () => ({ check: null, onLand: [{ kind: "grantAction", target: "self", attacks: 1 }], onAvoid: [] }) },
});
// Danger Sense: advantage on Dexterity saves. (The SRD asks for effects the barbarian can see.)
export const dangerSense = defineFeature({ id: "feature:danger-sense", source, traits: [{ kind: "saveAdvantage", abilities: ["dex"], always: true }], action: null });
export const fastMovement = defineFeature({ id: "feature:fast-movement", source, traits: [{ kind: "speedBonus", amount: 10 }], action: null });
export const unarmoredMovement = defineFeature({ id: "feature:unarmored-movement", source, traits: [{ kind: "speedBonus", amount: 10 }], action: null });
// College of Lore (Bard 3): narrative. Cutting Words (a reaction to reduce
// an enemy's roll) is its own reaction-shaped project (see step 16's note on
// why Shield stays the only reaction of its kind for now); Additional
// Magical Secrets grants spells outside the class list.
export const collegeOfLore = narrative("college-of-lore");
// Circle of the Land (Druid 3): narrative. Its bonus spells and Natural
// Recovery (partial spell-slot recovery on a short rest) are not modeled.
// Natural Recovery is modeled (slots back on a short rest); the bonus land spells are not.
export const circleOfTheLand = defineFeature({
  id: "feature:circle-of-the-land",
  source,
  traits: [{ kind: "slotRecovery", feature: "feature:circle-of-the-land" }],
  action: null,
  resource: { count: 1, recharge: "longRest" },
});
// Way of the Open Hand (Monk 3): narrative. Its riders all trigger off
// Flurry of Blows, which needs Ki itself to be a mechanic first
// (feature:ki is narrative-only).
export const wayOfTheOpenHand = narrative("way-of-the-open-hand");
// Oath of Devotion (Paladin 3): narrative. Its Channel Divinity options
// need Paladins to have Channel Divinity at all, which only Clerics do here.
// Sacred Weapon (Channel Divinity): Charisma modifier added to attack rolls for a minute. Turn the Unholy is not modeled.
export const oathOfDevotion = defineFeature({
  id: "feature:oath-of-devotion",
  source,
  traits: [],
  action: {
    cost: "action",
    uses: { count: 1, recharge: "shortRest" },
    plan: ({ spellcastingModifier }) => ({
      check: null,
      onLand: [{ kind: "applyModifiers", target: "self", modifiers: [{ kind: "attackBonus", amount: Math.max(1, spellcastingModifier) }], duration: { kind: "rounds", count: 10 } }],
      onAvoid: [],
    }),
  },
});
// Hunter (Ranger 3): narrative. Its Hunter's Prey options (e.g. Colossus
// Slayer's extra damage once per turn) would need a new once-per-turn
// tracking mechanic, the shape Sneak Attack already special-cases for Rogue.
// Colossus Slayer is modeled; the other Hunter's Prey options are not.
export const hunter = defineFeature({ id: "feature:hunter", source, traits: [{ kind: "colossusSlayer" }], action: null });
export const metamagic = narrative("metamagic");
export const pactBoon = narrative("pact-boon");
// School of Evocation (Wizard 2): narrative. Sculpt Spells needs
// area-of-effect spells to matter, and none are modeled yet.
export const schoolOfEvocation = narrative("school-of-evocation");

export const srd51HigherLevelFeatures: readonly FeatureDefinition[] = [
  indomitable,
  superiorCritical,
  brutalCritical(""),
  brutalCritical("-2"),
  brutalCritical("-3"),
  evasion,
  auraOfProtection,
  auraOfCourage,
  improvedDivineSmite,
  purityOfBody,
  ...[6, 10, 14, 18].map(unarmoredMovementGrowth),
  extraAttack,
  extraAttack2,
  extraAttack3,
  cunningAction,
  uncannyDodge,
  channelDivinity,
  jackOfAllTrades,
  wildShape,
  divineSmite,
  fontOfMagic,
  eldritchInvocations,
  champion,
  dangerSense,
  fastMovement,
  unarmoredMovement,
  thief,
  pathOfTheBerserker,
  collegeOfLore,
  circleOfTheLand,
  wayOfTheOpenHand,
  oathOfDevotion,
  hunter,
  metamagic,
  pactBoon,
  schoolOfEvocation,
];
