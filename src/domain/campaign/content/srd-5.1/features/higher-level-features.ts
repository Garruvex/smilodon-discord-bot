import { defineFeature, type FeatureDefinition } from "../../../rules/content-definitions.js";

// Level 2, 3, 5, 11 and 20 class features (SRD 5.1, Classes), granted
// automatically as a hero levels up (character/leveling.ts's levelFeatures
// table). Extra Attack, Cunning Action, Divine Smite and Uncanny Dodge are
// mechanical (traits, read where an attack, a Dash/Disengage, or damage is
// declared); the rest are narrative only, same treatment as Thieves' Cant
// and the level-1 roster's narrative features. Wild Shape is mechanical too,
// but is its own thing (engine/combat/wild-shape.ts), not a trait, since it
// swaps the hero's whole stat block rather than reading one passively.
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
export const arcaneTradition = narrative("arcane-tradition");
export const martialArchetype = narrative("martial-archetype");
export const roguishArchetype = narrative("roguish-archetype");
export const primalPath = narrative("primal-path");
export const bardCollege = narrative("bard-college");
export const druidCircle = narrative("druid-circle");
export const monasticTradition = narrative("monastic-tradition");
export const sacredOath = narrative("sacred-oath");
export const rangerArchetype = narrative("ranger-archetype");
export const metamagic = narrative("metamagic");
export const pactBoon = narrative("pact-boon");

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
  arcaneTradition,
  martialArchetype,
  roguishArchetype,
  primalPath,
  bardCollege,
  druidCircle,
  monasticTradition,
  sacredOath,
  rangerArchetype,
  metamagic,
  pactBoon,
];
