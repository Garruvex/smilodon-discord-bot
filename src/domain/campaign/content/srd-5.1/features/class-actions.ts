import { defineFeature, type FeatureDefinition } from "../../../rules/content-definitions.js";

// Class features that are actions of their own: each is resolved like any other action
// (rules/content-definitions.ts's FeatureAction), against the hero it belongs to.
const source = "SRD 5.1";

// Fighter 2: one more action this turn, once per short rest.
export const actionSurge = defineFeature({
  id: "feature:action-surge",
  source,
  traits: [],
  action: {
    cost: "free",
    uses: { count: 1, perLevel: (level) => (level >= 17 ? 2 : 1), recharge: "shortRest" },
    plan: () => ({ check: null, onLand: [{ kind: "grantAction", target: "self" }], onAvoid: [] }),
  },
});

// Barbarian 2: advantage on your attacks this turn, and attacks against you have advantage until
// your next turn. The SRD limits the first to Strength melee attacks; here it covers every attack.
// There is no cap per rest, so the count is only there to hold the use.
export const recklessAttack = defineFeature({
  id: "feature:reckless-attack",
  source,
  traits: [],
  action: {
    cost: "free",
    uses: { count: 99, recharge: "shortRest" },
    plan: () => ({
      check: null,
      onLand: [
        {
          kind: "applyModifiers",
          target: "self",
          modifiers: [
            { kind: "ownAttacks", mode: "advantage" },
            { kind: "attacksAgainst", mode: "advantage", reach: "any" },
          ],
          duration: { kind: "rounds", count: 1 },
        },
      ],
      onAvoid: [],
    }),
  },
});

// Monk 2: ki points equal to the monk's level, back on a short rest. The abilities below spend them.
export const ki = defineFeature({ id: "feature:ki", source, traits: [], action: null, resource: { count: 2, perLevel: (level) => level, recharge: "shortRest" } });

const kiCost = { pool: "feature:ki" } as const;

// Two more strikes this turn for a ki point. The SRD makes them unarmed; here they use whatever weapon is in hand.
export const flurryOfBlows = defineFeature({
  id: "feature:flurry-of-blows",
  source,
  traits: [],
  action: { cost: "bonusAction", uses: kiCost, plan: () => ({ check: null, onLand: [{ kind: "grantAction", target: "self", attacks: 2 }], onAvoid: [] }) },
});

export const patientDefense = defineFeature({
  id: "feature:patient-defense",
  source,
  traits: [],
  action: {
    cost: "bonusAction",
    uses: kiCost,
    plan: () => ({
      check: null,
      onLand: [{ kind: "applyModifiers", target: "self", modifiers: [{ kind: "attacksAgainst", mode: "disadvantage", reach: "any" }], duration: { kind: "rounds", count: 1 } }],
      onAvoid: [],
    }),
  },
});

// Disengage only: the extra jump distance and the Dash are not modeled.
export const stepOfTheWind = defineFeature({
  id: "feature:step-of-the-wind",
  source,
  traits: [],
  action: {
    cost: "bonusAction",
    uses: kiCost,
    plan: () => ({ check: null, onLand: [{ kind: "applyModifiers", target: "self", modifiers: [{ kind: "avoidsOpportunityAttacks" }], duration: { kind: "rounds", count: 1 } }], onAvoid: [] }),
  },
});

// Monk 5: readies a stun for the next melee hit (a ki point); the target makes a Constitution save or is stunned.
export const stunningStrike = defineFeature({
  id: "feature:stunning-strike",
  source,
  traits: [],
  action: {
    cost: "free",
    uses: kiCost,
    plan: () => ({ check: null, onLand: [{ kind: "applyModifiers", target: "self", modifiers: [{ kind: "stunningStrike" }], duration: { kind: "rounds", count: 1 } }], onAvoid: [] }),
  },
});

// Hide, open to every class: an action (a bonus action for a rogue) to slip from sight in a zone with cover or darkness, out of any foe's reach.
// The Stealth contest against passive Perception is not rolled: hiding works if the place allows it. The next attack or spell ends it.
export const hide = defineFeature({
  id: "feature:hide",
  source,
  traits: [],
  action: {
    cost: "action",
    uses: { count: 99, recharge: "shortRest" },
    plan: () => ({ check: null, onLand: [{ kind: "applyModifiers", target: "self", modifiers: [{ kind: "hidden" }], duration: { kind: "untilRemoved" } }], onAvoid: [] }),
  },
});

export const srd51ClassActions: readonly FeatureDefinition[] = [hide, actionSurge, recklessAttack, ki, flurryOfBlows, patientDefense, stepOfTheWind, stunningStrike];
