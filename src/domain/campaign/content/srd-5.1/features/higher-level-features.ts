import { defineFeature, type FeatureDefinition } from "../../../rules/content-definitions.js";
import type { Effect } from "../../../rules/effects.js";
import type { MetamagicOption } from "../../../rules/modifiers.js";

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
    { kind: "featureSpell", spell: "spell:preserve-life", ability: "wis", uses: 1, usesAt: [{ level: 6, uses: 2 }, { level: 18, uses: 3 }], recharge: "shortRest" },
    { kind: "featureSpell", spell: "spell:turn-undead", ability: "wis", uses: 1, usesAt: [{ level: 6, uses: 2 }, { level: 18, uses: 3 }], recharge: "shortRest" },
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
// Destroy Undead is part of Turn Undead (class-ability-spells.ts); this names it on the sheet.
export const destroyUndead = narrative("destroy-undead");
// Font of Inspiration: Bardic Inspiration comes back on a short rest (engine/rest.ts).
export const fontOfInspiration = narrative("font-of-inspiration");
export const feralInstinct = defineFeature({ id: "feature:feral-instinct", source, traits: [{ kind: "feralInstinct" }], action: null });
export const superiorCritical = defineFeature({ id: "feature:superior-critical", source, traits: [{ kind: "expandedCritRange", threshold: 18 }], action: null });
const brutalCritical = (suffix: string): FeatureDefinition => defineFeature({ id: `feature:brutal-critical${suffix}`, source, traits: [{ kind: "brutalCritical", dice: 1 }], action: null });
export const evasion = defineFeature({ id: "feature:evasion", source, traits: [{ kind: "evasion" }], action: null });
// The bonus is filled in from the holder's Charisma modifier (combat/combatant-profile.ts).
export const auraOfProtection = defineFeature({ id: "feature:aura-of-protection", source, traits: [{ kind: "auraOfProtection", bonus: 1 }], action: null });
export const auraOfCourage = defineFeature({ id: "feature:aura-of-courage", source, traits: [{ kind: "auraOfImmunity", conditions: ["condition:frightened"] }], action: null });
export const improvedDivineSmite = defineFeature({ id: "feature:improved-divine-smite", source, traits: [{ kind: "improvedDivineSmite" }], action: null });
export const purityOfBody = defineFeature({
  id: "feature:purity-of-body",
  source,
  traits: [{ kind: "damageImmunity", damageTypes: ["poison"] }, { kind: "conditionImmunity", conditions: ["condition:poisoned"] }],
  action: null,
});
// A monk's Unarmored Movement grows by 5 feet at levels 6, 10, 14 and 18.
const unarmoredMovementGrowth = (level: number): FeatureDefinition => defineFeature({ id: `feature:unarmored-movement-${level}`, source, traits: [{ kind: "speedBonus", amount: 5 }], action: null });
// Read where a skill check is resolved (engine/checks.ts).
export const reliableTalent = narrative("reliable-talent");
// Every martial class can grapple and shove (spells/class-ability-spells.ts); at will, on Strength.
export const grappleFeature = defineFeature({ id: "feature:grapple", source, traits: [{ kind: "featureSpell", spell: "spell:grapple", ability: "str", uses: null, recharge: "longRest" }], action: null });
export const escapeGrappleFeature = defineFeature({ id: "feature:escape-grapple", source, traits: [{ kind: "featureSpell", spell: "spell:escape-grapple", ability: "str", uses: null, recharge: "longRest" }], action: null });
// Reactions that fire by themselves can be held back, so the reaction is kept for a choice (an opportunity attack, Shield, a Counterspell).
const freeSwitch = (id: string, onLand: readonly Effect[]): FeatureDefinition =>
  defineFeature({ id: `feature:${id}`, source, traits: [], action: { cost: "free", uses: { count: 99, recharge: "shortRest" }, plan: () => ({ check: null, onLand, onAvoid: [] }) } });
export const holdReactions = freeSwitch("hold-reactions", [{ kind: "applyCondition", target: "self", condition: "condition:holding-reactions", duration: { kind: "untilRemoved" } }]);
export const resumeReactions = freeSwitch("resume-reactions", [{ kind: "removeCondition", target: "self", conditions: ["condition:holding-reactions"] }]);
export const shoveFeature = defineFeature({ id: "feature:shove", source, traits: [{ kind: "featureSpell", spell: "spell:shove", ability: "str", uses: null, recharge: "longRest" }], action: null });
export const readyFeature = defineFeature({ id: "feature:ready", source, traits: [{ kind: "featureSpell", spell: "spell:ready", ability: "str", uses: null, recharge: "longRest" }], action: null });
export const helpFeature = defineFeature({ id: "feature:help", source, traits: [{ kind: "featureSpell", spell: "spell:help", ability: "str", uses: null, recharge: "longRest" }], action: null });
// Barbarian 11: read where damage drops a raging barbarian to 0 (engine/combat/damage.ts).
export const relentlessRage = defineFeature({ id: "feature:relentless-rage", source, traits: [], action: null, resource: { count: 1, recharge: "longRest" } });
export const jackOfAllTrades = narrative("jack-of-all-trades");
export const wildShape = defineFeature({ id: "feature:wild-shape", source, traits: [{ kind: "wildShape" }], action: null });
export const divineSmite = defineFeature({ id: "feature:divine-smite", source, traits: [{ kind: "divineSmite" }], action: null });
// Font of Magic: sorcery points equal to the sorcerer's level, back on a long rest. Metamagic spends them.
export const fontOfMagic = defineFeature({ id: "feature:font-of-magic", source, traits: [], action: null, resource: { count: 2, perLevel: (level) => level, recharge: "longRest" } });
// Readies a Metamagic option for the next spell cast; the sorcery points are spent now. This build gives a sorcerer
// Quickened Spell (2 points) and Twinned Spell (a flat 2 points, where the SRD charges the spell's level).
const metamagicOption = (name: string, option: MetamagicOption, spend: number): FeatureDefinition =>
  defineFeature({
    id: `feature:${name}`,
    source,
    traits: [],
    action: {
      cost: "free",
      uses: { pool: "feature:font-of-magic" },
      spend,
      plan: () => ({ check: null, onLand: [{ kind: "applyModifiers", target: "self", modifiers: [{ kind: "metamagic", option }], duration: { kind: "rounds", count: 1 } }], onAvoid: [] }),
    },
  });
export const quickenedSpell = metamagicOption("quickened-spell", "quickened", 2);
export const twinnedSpell = metamagicOption("twinned-spell", "twinned", 2);
// Careful Spell (Sorcerer 3): friends in the area, as many as the Charisma modifier (at least one), succeed on the save without rolling.
export const carefulSpell = metamagicOption("careful-spell", "careful", 1);
// Sorcerer 10 and 17: Heightened (the first target saves at disadvantage), Empowered (the spellcasting modifier on one damage roll,
// where the SRD rerolls that many dice), Extended (timed effects last twice as long) and Subtle (cannot be countered).
export const heightenedSpell = metamagicOption("heightened-spell", "heightened", 3);
export const empoweredSpell = metamagicOption("empowered-spell", "empowered", 1);
export const extendedSpell = metamagicOption("extended-spell", "extended", 1);
export const subtleSpell = metamagicOption("subtle-spell", "subtle", 1);
// Flexible Casting (Sorcerer 2): sorcery points turned into a spell slot of the 1st to the 5th level (2, 3, 5, 6 and 7 points).
const createSlot = (level: number, cost: number): FeatureDefinition =>
  defineFeature({
    id: `feature:create-slot-${level}`,
    source,
    traits: [],
    action: { cost: "bonusAction", uses: { pool: "feature:font-of-magic" }, spend: cost, plan: () => ({ check: null, onLand: [{ kind: "gainSlot", target: "self", level }], onAvoid: [] }) },
  });
// Flexible Casting, the other way: a spell slot becomes sorcery points equal to its level (a bonus action).
const slotToPoints = (level: number): FeatureDefinition =>
  defineFeature({
    id: `feature:slot-to-points-${level}`,
    source,
    traits: [],
    action: { cost: "bonusAction", uses: { count: 99, recharge: "shortRest" }, plan: () => ({ check: null, onLand: [{ kind: "convertSlot", target: "self", level }], onAvoid: [] }) },
  });
export const slotsToPoints: readonly FeatureDefinition[] = [1, 2, 3, 4, 5].map(slotToPoints);
export const createSlots: readonly FeatureDefinition[] = [createSlot(1, 2), createSlot(2, 3), createSlot(3, 5), createSlot(4, 6), createSlot(5, 7)];
// Eldritch Invocations: every warlock takes these three at level 2 (this build has no choosing of invocations).
export const eldritchInvocations = narrative("eldritch-invocations");
export const agonizingBlast = defineFeature({ id: "feature:agonizing-blast", source, traits: [{ kind: "agonizingBlast" }], action: null });
export const armorOfShadows = defineFeature({ id: "feature:armor-of-shadows", source, traits: [{ kind: "featureSpell", spell: "spell:mage-armor", ability: "cha", uses: null, recharge: "longRest" }], action: null });
export const fiendishVigor = defineFeature({ id: "feature:fiendish-vigor", source, traits: [{ kind: "featureSpell", spell: "spell:false-life", ability: "cha", uses: null, recharge: "longRest" }], action: null });
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
// The invocations and pact boons a warlock may choose (character/warlock-choices.ts).
export const repellingBlast = defineFeature({ id: "feature:repelling-blast", source, traits: [{ kind: "repellingBlast" }], action: null });
export const devilsSight = defineFeature({ id: "feature:devils-sight", source, traits: [{ kind: "darkvision", feet: 120 }], action: null });
export const thiefOfFiveFates = defineFeature({ id: "feature:thief-of-five-fates", source, traits: [{ kind: "featureSpell", spell: "spell:bane", ability: "cha", uses: 1, recharge: "longRest" }], action: null });
export const eldritchSight = narrative("eldritch-sight");
export const beastSpeech = narrative("beast-speech");
export const maskOfManyFaces = narrative("mask-of-many-faces");
export const mistyVisions = narrative("misty-visions");
// The chain's familiar is Find Familiar as a ritual (kept between fights, companions/companion-roster.ts); the tome's book holds three cantrips
// from any list; the blade's weapon is narrative here, the warlock fights with the weapons they carry.
export const pactOfTheChain = defineFeature({ id: "feature:pact-of-the-chain", source, traits: [{ kind: "featureSpell", spell: "spell:find-familiar", ability: "cha", uses: null, recharge: "longRest" }], action: null });
export const pactOfTheBlade = narrative("pact-of-the-blade");
export const pactOfTheTome = defineFeature({
  id: "feature:pact-of-the-tome",
  source,
  traits: [
    { kind: "featureSpell", spell: "spell:guidance", ability: "cha", uses: null, recharge: "longRest" },
    { kind: "featureSpell", spell: "spell:sacred-flame", ability: "cha", uses: null, recharge: "longRest" },
    { kind: "featureSpell", spell: "spell:shocking-grasp", ability: "cha", uses: null, recharge: "longRest" },
  ],
  action: null,
});
// School of Evocation (Wizard 2): narrative. Sculpt Spells needs
// area-of-effect spells to matter, and none are modeled yet.
export const schoolOfEvocation = narrative("school-of-evocation");

export const srd51HigherLevelFeatures: readonly FeatureDefinition[] = [
  relentlessRage,
  grappleFeature,
  shoveFeature,
  helpFeature,
  readyFeature,
  escapeGrappleFeature,
  holdReactions,
  resumeReactions,
  reliableTalent,
  agonizingBlast,
  repellingBlast,
  devilsSight,
  thiefOfFiveFates,
  eldritchSight,
  beastSpeech,
  maskOfManyFaces,
  mistyVisions,
  pactOfTheChain,
  pactOfTheBlade,
  pactOfTheTome,
  armorOfShadows,
  fiendishVigor,
  quickenedSpell,
  twinnedSpell,
  carefulSpell,
  ...createSlots,
  ...slotsToPoints,
  heightenedSpell,
  empoweredSpell,
  extendedSpell,
  subtleSpell,
  destroyUndead,
  fontOfInspiration,
  feralInstinct,
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
