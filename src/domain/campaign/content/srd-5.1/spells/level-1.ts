import { dice, plus } from "../../../dice/dice-expression.js";
import { defineSpell, type SpellDefinition } from "../../../rules/content-definitions.js";

const source = "SRD 5.1";

// Cast as a reaction when a hit would land: +5 armor class until the start of the
// caster's next turn (a hit that no longer beats it becomes a miss).
export const shieldSpell = defineSpell({
  id: "spell:shield",
  source,
  level: 1,
  castingTime: "reaction",
  range: { kind: "self" },
  targeting: { relation: "self", count: 1 },
  concentration: false,
  reaction: { kind: "acBonusUntilNextTurn", bonus: 5 },
  plan: () => ({ check: null, onLand: [], onAvoid: [] }),
});

export const cureWounds = defineSpell({
  id: "spell:cure-wounds",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "touch" },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: ({ slotLevel, spellcastingModifier }) => ({
    check: null,
    onLand: [{ kind: "heal", target: "target", amount: plus(dice(slotLevel, 8), spellcastingModifier) }],
    onAvoid: [],
  }),
});

export const healingWord = defineSpell({
  id: "spell:healing-word",
  source,
  level: 1,
  castingTime: "bonus-action",
  range: { kind: "feet", feet: 60 },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: ({ slotLevel, spellcastingModifier }) => ({
    check: null,
    onLand: [{ kind: "heal", target: "target", amount: plus(dice(slotLevel, 4), spellcastingModifier) }],
    onAvoid: [],
  }),
});

export const bless = defineSpell({
  id: "spell:bless",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "feet", feet: 30 },
  targeting: { relation: "creature", count: 3, countPerHigherSlot: 1 },
  concentration: true,
  plan: () => ({
    check: null,
    onLand: [
      {
        kind: "bonusDie",
        target: "target",
        die: dice(1, 4),
        appliesTo: ["attack", "save"],
        duration: { kind: "rounds", count: 10 },
      },
    ],
    onAvoid: [],
  }),
});

export const guidingBolt = defineSpell({
  id: "spell:guiding-bolt",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "feet", feet: 120 },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: ({ slotLevel }) => ({
    check: { kind: "spellAttack" },
    onLand: [
      { kind: "damage", target: "target", amount: dice(3 + slotLevel, 6), damageType: "radiant" },
      { kind: "nextAttackAdvantage", target: "target" },
    ],
    onAvoid: [],
  }),
});

// Added for the full SRD class roster (step 7).

// Simplified: one target takes the full missile damage, rather than several
// darts that can be split between targets.
export const magicMissile = defineSpell({
  id: "spell:magic-missile",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "feet", feet: 120 },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: ({ slotLevel }) => ({
    check: null,
    onLand: [{ kind: "damage", target: "target", amount: plus(dice(slotLevel + 2, 4), slotLevel + 2), damageType: "force" }],
    onAvoid: [],
  }),
});

// Simplified: a single bolt, not the ongoing arc a held concentration keeps
// striking with each turn.
export const witchBolt = defineSpell({
  id: "spell:witch-bolt",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "feet", feet: 30 },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: ({ slotLevel }) => ({
    check: { kind: "spellAttack" },
    onLand: [{ kind: "damage", target: "target", amount: dice(slotLevel, 12), damageType: "lightning" }],
    onAvoid: [],
  }),
});

// Added for engine-robustness pass (step 8). Simplified: Command's other
// one-word effects (Flee, Grovel, Approach) are dropped; only "Halt" is
// modeled, as one round of the Incapacitated condition on a failed save.
export const command = defineSpell({
  id: "spell:command",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "feet", feet: 60 },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: () => ({
    check: { kind: "savingThrow", ability: "wis" },
    onLand: [{ kind: "applyCondition", target: "target", condition: "condition:incapacitated", duration: { kind: "rounds", count: 1 } }],
    onAvoid: [],
  }),
});

// Added for engine-robustness pass (step 14).
export const inflictWounds = defineSpell({
  id: "spell:inflict-wounds",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "touch" },
  targeting: { relation: "creature", count: 1 },
  concentration: false,
  plan: ({ slotLevel }) => ({
    check: { kind: "spellAttack" },
    onLand: [{ kind: "damage", target: "target", amount: dice(2 + slotLevel, 10), damageType: "necrotic" }],
    onAvoid: [],
  }),
});

// Simplified: the condition ends early if the target takes damage or
// someone uses an action to shake it (the engine has no effect for either);
// it just runs its full duration.
export const tashasHideousLaughter = defineSpell({
  id: "spell:tashas-hideous-laughter",
  source,
  level: 1,
  castingTime: "action",
  range: { kind: "feet", feet: 30 },
  targeting: { relation: "creature", count: 1 },
  concentration: true,
  plan: () => ({
    check: { kind: "savingThrow", ability: "wis" },
    onLand: [
      { kind: "applyCondition", target: "target", condition: "condition:incapacitated", duration: { kind: "rounds", count: 10 } },
      { kind: "applyCondition", target: "target", condition: "condition:prone", duration: { kind: "rounds", count: 10 } },
    ],
    onAvoid: [],
  }),
});

export const srd51Level1Spells: readonly SpellDefinition[] = [
  cureWounds,
  healingWord,
  bless,
  guidingBolt,
  shieldSpell,
  magicMissile,
  witchBolt,
  command,
  inflictWounds,
  tashasHideousLaughter,
];
