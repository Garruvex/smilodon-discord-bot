import { rollD20Test, rollMatchesSpec, type D20TestRoll, type D20TestSpec } from "./d20-test.js";
import type { DiceExpression } from "./dice-expression.js";
import type { RandomSource } from "./random-source.js";
import { rollExpression, type ExpressionRoll } from "./roll.js";

// Every roll the engine asks for: a d20 test (checks, attacks, saves,
// initiative, death saves) or plain dice (damage, healing). One request and
// result shape means every roll goes through the same roll-once path.
export type RollSpec =
  | { readonly kind: "d20Test"; readonly spec: D20TestSpec }
  | { readonly kind: "dice"; readonly expression: DiceExpression; readonly critical: boolean };

export type RollResult = { readonly kind: "d20Test"; readonly roll: D20TestRoll } | { readonly kind: "dice"; readonly roll: ExpressionRoll };

export function performRoll(spec: RollSpec, source: RandomSource): RollResult {
  return spec.kind === "d20Test"
    ? { kind: "d20Test", roll: rollD20Test(spec.spec, source) }
    : { kind: "dice", roll: rollExpression(spec.expression, source, { critical: spec.critical }) };
}

// Whether a recorded result could have come from this spec, so a result
// saved for one roll can never resolve another.
export function resultMatchesSpec(result: RollResult, spec: RollSpec): boolean {
  if (result.kind === "d20Test" && spec.kind === "d20Test") return rollMatchesSpec(result.roll, spec.spec);
  if (result.kind !== "dice" || spec.kind !== "dice") return false;
  const expected = spec.critical ? spec.expression.terms.map((term) => ({ ...term, count: term.count * 2 })) : spec.expression.terms;
  const roll = result.roll;
  if (roll.modifier !== spec.expression.modifier || roll.terms.length !== expected.length) return false;
  let total = roll.modifier;
  for (const [index, term] of roll.terms.entries()) {
    const wanted = expected[index];
    if (wanted === undefined || term.sides !== wanted.sides || term.values.length !== wanted.count) return false;
    if (term.values.some((value) => !Number.isInteger(value) || value < 1 || value > term.sides)) return false;
    total += term.values.reduce((sum, value) => sum + value, 0);
  }
  return roll.total === total;
}
