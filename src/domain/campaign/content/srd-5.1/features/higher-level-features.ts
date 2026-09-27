import { defineFeature, type FeatureDefinition } from "../../../rules/content-definitions.js";

// Level 2, 3 and 5 class features (SRD 5.1, Classes), granted automatically
// as a hero levels up (character/leveling.ts's levelFeatures table). Extra
// Attack and Cunning Action are mechanical (traits, read where an attack or
// a Dash/Disengage is declared); the rest are narrative only, same treatment
// as Thieves' Cant and the level-1 roster's narrative features. Levels
// beyond 5, and the mechanical features this still skips (Uncanny Dodge,
// Wild Shape, Divine Smite), are out of scope for now.
const source = "SRD 5.1";

const narrative = (name: string): FeatureDefinition => defineFeature({ id: `feature:${name}`, source, traits: [], action: null });

// Fighter, Barbarian, Paladin, Ranger and Monk all gain this at level 5.
export const extraAttack = defineFeature({ id: "feature:extra-attack", source, traits: [{ kind: "extraAttack" }], action: null });

export const actionSurge = narrative("action-surge");
// Hide is not modeled, so only Dash and Disengage move to the bonus action.
export const cunningAction = defineFeature({ id: "feature:cunning-action", source, traits: [{ kind: "cunningAction" }], action: null });
export const channelDivinity = narrative("channel-divinity");
export const recklessAttack = narrative("reckless-attack");
export const jackOfAllTrades = narrative("jack-of-all-trades");
export const wildShape = narrative("wild-shape");
export const ki = narrative("ki");
export const divineSmite = narrative("divine-smite");
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
  actionSurge,
  cunningAction,
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
