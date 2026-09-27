import { dice } from "../../../dice/dice-expression.js";
import { defineSpell, type SpellDefinition } from "../../../rules/content-definitions.js";

const source = "SRD 5.1";

// 2014 cantrip damage scaling: one extra die at character levels 5, 11, and 17.
export function cantripDiceCount(casterLevel: number): number {
  if (casterLevel >= 17) return 4;
  if (casterLevel >= 11) return 3;
  if (casterLevel >= 5) return 2;
  return 1;
}

export const sacredFlame = defineSpell({
  id: "spell:sacred-flame",
  source,
  level: 0,
  castingTime: "action",
  range: { kind: "feet", feet: 60 },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: ({ casterLevel }) => ({
    check: { kind: "savingThrow", ability: "dex" },
    onLand: [{ kind: "damage", target: "target", amount: dice(cantripDiceCount(casterLevel), 8), damageType: "radiant" }],
    onAvoid: [],
  }),
});

// Narrative only: the effects are for the story (a booming voice, a trembling
// floor), so the plan changes no state and the Narrator describes it.
export const thaumaturgy = defineSpell({
  id: "spell:thaumaturgy",
  source,
  level: 0,
  castingTime: "action",
  range: { kind: "feet", feet: 30 },
  targeting: { relation: "self", count: 1 },
  concentration: false,
  plan: () => ({ check: null, onLand: [], onAvoid: [] }),
});

// Added for the full SRD class roster (step 7): a damage cantrip per new
// spellcasting class, all shaped like sacredFlame (attack or save, one damage
// effect that scales with cantripDiceCount).
export const viciousMockery = defineSpell({
  id: "spell:vicious-mockery",
  source,
  level: 0,
  castingTime: "action",
  range: { kind: "feet", feet: 60 },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  // Simplified: the SRD's "disadvantage on its next attack roll" is dropped;
  // the engine has no effect for imposing disadvantage on someone else's roll.
  plan: ({ casterLevel }) => ({
    check: { kind: "savingThrow", ability: "wis" },
    onLand: [{ kind: "damage", target: "target", amount: dice(cantripDiceCount(casterLevel), 4), damageType: "psychic" }],
    onAvoid: [],
  }),
});

export const produceFlame = defineSpell({
  id: "spell:produce-flame",
  source,
  level: 0,
  castingTime: "action",
  range: { kind: "feet", feet: 30 },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: ({ casterLevel }) => ({
    check: { kind: "spellAttack" },
    onLand: [{ kind: "damage", target: "target", amount: dice(cantripDiceCount(casterLevel), 8), damageType: "fire" }],
    onAvoid: [],
  }),
});

export const fireBolt = defineSpell({
  id: "spell:fire-bolt",
  source,
  level: 0,
  castingTime: "action",
  range: { kind: "feet", feet: 120 },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: ({ casterLevel }) => ({
    check: { kind: "spellAttack" },
    onLand: [{ kind: "damage", target: "target", amount: dice(cantripDiceCount(casterLevel), 10), damageType: "fire" }],
    onAvoid: [],
  }),
});

// Simplified: one bolt scaled by cantripDiceCount, rather than several beams
// that can be split between targets.
export const eldritchBlast = defineSpell({
  id: "spell:eldritch-blast",
  source,
  level: 0,
  castingTime: "action",
  range: { kind: "feet", feet: 120 },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: ({ casterLevel }) => ({
    check: { kind: "spellAttack" },
    onLand: [{ kind: "damage", target: "target", amount: dice(cantripDiceCount(casterLevel), 10), damageType: "force" }],
    onAvoid: [],
  }),
});

export const srd51Cantrips: readonly SpellDefinition[] = [sacredFlame, thaumaturgy, viciousMockery, produceFlame, fireBolt, eldritchBlast];
