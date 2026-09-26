import { dice, plus } from "../../../dice/dice-expression.js";
import { defineSpell, type SpellDefinition } from "../../../rules/content-definitions.js";

const source = "SRD 5.1";

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

export const srd51Level1Spells: readonly SpellDefinition[] = [cureWounds, healingWord, bless];
