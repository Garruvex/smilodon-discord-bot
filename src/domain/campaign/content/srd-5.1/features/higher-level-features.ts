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

export const actionSurge = narrative("action-surge");
// Hide is not modeled, so only Dash and Disengage move to the bonus action.
export const cunningAction = defineFeature({ id: "feature:cunning-action", source, traits: [{ kind: "cunningAction" }], action: null });
export const uncannyDodge = defineFeature({ id: "feature:uncanny-dodge", source, traits: [{ kind: "uncannyDodge" }], action: null });
export const channelDivinity = narrative("channel-divinity");
export const recklessAttack = narrative("reckless-attack");
export const jackOfAllTrades = narrative("jack-of-all-trades");
export const wildShape = defineFeature({ id: "feature:wild-shape", source, traits: [{ kind: "wildShape" }], action: null });
export const ki = narrative("ki");
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
export const pathOfTheBerserker = narrative("path-of-the-berserker");
// College of Lore (Bard 3): narrative. Cutting Words (a reaction to reduce
// an enemy's roll) is its own reaction-shaped project (see step 16's note on
// why Shield stays the only reaction of its kind for now); Additional
// Magical Secrets grants spells outside the class list.
export const collegeOfLore = narrative("college-of-lore");
// Circle of the Land (Druid 3): narrative. Its bonus spells and Natural
// Recovery (partial spell-slot recovery on a short rest) are not modeled.
export const circleOfTheLand = narrative("circle-of-the-land");
// Way of the Open Hand (Monk 3): narrative. Its riders all trigger off
// Flurry of Blows, which needs Ki itself to be a mechanic first
// (feature:ki is narrative-only).
export const wayOfTheOpenHand = narrative("way-of-the-open-hand");
// Oath of Devotion (Paladin 3): narrative. Its Channel Divinity options
// need Paladins to have Channel Divinity at all, which only Clerics do here.
export const oathOfDevotion = narrative("oath-of-devotion");
// Hunter (Ranger 3): narrative. Its Hunter's Prey options (e.g. Colossus
// Slayer's extra damage once per turn) would need a new once-per-turn
// tracking mechanic, the shape Sneak Attack already special-cases for Rogue.
export const hunter = narrative("hunter");
export const metamagic = narrative("metamagic");
export const pactBoon = narrative("pact-boon");
// School of Evocation (Wizard 2): narrative. Sculpt Spells needs
// area-of-effect spells to matter, and none are modeled yet.
export const schoolOfEvocation = narrative("school-of-evocation");

export const srd51HigherLevelFeatures: readonly FeatureDefinition[] = [
  extraAttack,
  extraAttack2,
  extraAttack3,
  actionSurge,
  cunningAction,
  uncannyDodge,
  channelDivinity,
  recklessAttack,
  jackOfAllTrades,
  wildShape,
  ki,
  divineSmite,
  fontOfMagic,
  eldritchInvocations,
  champion,
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
