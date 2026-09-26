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

export const srd51Cantrips: readonly SpellDefinition[] = [sacredFlame];
