import { defineFeature, type FeatureDefinition } from "../../../rules/content-definitions.js";

// Level 2 and 3 class features (SRD 5.1, Classes), granted automatically as
// a hero levels up (character/leveling.ts's levelFeatures table). Narrative
// only, same treatment as Thieves' Cant and the level-1 roster's narrative
// features: the hero card names them, but no rule reads them yet. Levels
// beyond 3, and the mechanical features this skips (Extra Attack, Uncanny
// Dodge, Wild Shape, Divine Smite, Cunning Action, Sneak Attack's scaling),
// are out of scope for now.
const source = "SRD 5.1";

const narrative = (name: string): FeatureDefinition => defineFeature({ id: `feature:${name}`, source, traits: [], action: null });

export const actionSurge = narrative("action-surge");
export const cunningAction = narrative("cunning-action");
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
