import { multiplyDice, type DiceExpression, type DieSize } from "./dice-expression.js";
import type { RandomSource } from "./random-source.js";

export interface TermRoll {
  readonly sides: DieSize;
  readonly values: readonly number[];
}

export interface ExpressionRoll {
  // The expression actually rolled — for a critical hit this already has
  // the doubled dice, so a saved roll is self-describing.
  readonly expression: DiceExpression;
  readonly terms: readonly TermRoll[];
  readonly modifier: number;
  readonly total: number;
}

export interface ExpressionRollOptions {
  readonly critical?: boolean;
}

export function rollExpression(
  expression: DiceExpression,
  source: RandomSource,
  options: ExpressionRollOptions = {},
): ExpressionRoll {
  const rolled = options.critical === true ? multiplyDice(expression, 2) : expression;
  const terms = rolled.terms.map((term) => ({
    sides: term.sides,
    values: Array.from({ length: term.count }, () => rollDie(term.sides, source)),
  }));
  const diceTotal = terms.reduce((sum, term) => sum + term.values.reduce((a, b) => a + b, 0), 0);
  return { expression: rolled, terms, modifier: rolled.modifier, total: diceTotal + rolled.modifier };
}

export type RollMode = "normal" | "advantage" | "disadvantage";

// 2014 rule: any number of advantage sources and any number of disadvantage
// sources cancel to a normal roll; several of one kind still roll only two dice.
export function resolveRollMode(advantageSources: number, disadvantageSources: number): RollMode {
  if (advantageSources > 0 && disadvantageSources > 0) return "normal";
  if (advantageSources > 0) return "advantage";
  if (disadvantageSources > 0) return "disadvantage";
  return "normal";
}

export interface D20Roll {
  readonly mode: RollMode;
  // One value for a normal roll, two for advantage/disadvantage, in the order rolled.
  readonly values: readonly number[];
  readonly natural: number;
  readonly modifier: number;
  readonly total: number;
}

export function rollD20(mode: RollMode, modifier: number, source: RandomSource): D20Roll {
  if (!Number.isInteger(modifier)) {
    throw new RangeError(`d20 modifier must be an integer, got ${modifier}.`);
  }
  const values = mode === "normal" ? [rollDie(20, source)] : [rollDie(20, source), rollDie(20, source)];
  const natural = mode === "advantage" ? Math.max(...values) : Math.min(...values);
  return { mode, values, natural, modifier, total: natural + modifier };
}

function rollDie(sides: DieSize, source: RandomSource): number {
  const value = source.nextInt(1, sides);
  if (!Number.isInteger(value) || value < 1 || value > sides) {
    throw new RangeError(`RandomSource returned ${value} for a d${sides}.`);
  }
  return value;
}
