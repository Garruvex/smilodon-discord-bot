import type { DiceExpression } from "./dice-expression.js";
import type { RandomSource } from "./random-source.js";
import { rollD20, rollExpression, type D20Roll, type ExpressionRoll, type RollMode } from "./roll.js";

// A d20 test (2014 rules): an attack roll, ability check, saving throw, or
// death saving throw, compared against a target number (AC or DC; 10 for
// death saves).
export type D20TestKind = "attack" | "abilityCheck" | "savingThrow" | "deathSave";

// Extra dice added to a d20 test, such as Bless's 1d4. `source` names the
// effect so results can say what made the difference.
export interface BonusDieSpec {
  readonly source: string;
  readonly die: DiceExpression;
}

// Everything needed to roll a test, fixed before the roll.
export interface D20TestSpec {
  readonly mode: RollMode;
  readonly modifier: number;
  readonly bonusDice: readonly BonusDieSpec[];
}

export interface BonusDieRoll {
  readonly source: string;
  readonly roll: ExpressionRoll;
}

export interface D20TestRoll {
  readonly d20: D20Roll;
  readonly bonusDice: readonly BonusDieRoll[];
  readonly total: number;
}

export function rollD20Test(spec: D20TestSpec, source: RandomSource): D20TestRoll {
  const d20 = rollD20(spec.mode, spec.modifier, source);
  const bonusDice = spec.bonusDice.map((bonus) => ({ source: bonus.source, roll: rollExpression(bonus.die, source) }));
  return { d20, bonusDice, total: d20.total + bonusTotal(bonusDice) };
}

export function bonusTotal(bonusDice: readonly BonusDieRoll[]): number {
  return bonusDice.reduce((sum, bonus) => sum + bonus.roll.total, 0);
}

// Whether a saved roll could have come from this spec: same mode, modifier,
// die count, and bonus sources. Guards against a result recorded for a
// different check.
export function rollMatchesSpec(roll: D20TestRoll, spec: D20TestSpec): boolean {
  const d20 = roll.d20;
  if (d20.mode !== spec.mode || d20.modifier !== spec.modifier) return false;
  if (d20.values.length !== (spec.mode === "normal" ? 1 : 2)) return false;
  if (d20.values.some((value) => !Number.isInteger(value) || value < 1 || value > 20)) return false;
  const expectedNatural = spec.mode === "advantage" ? Math.max(...d20.values) : Math.min(...d20.values);
  if (d20.natural !== expectedNatural || d20.total !== d20.natural + d20.modifier) return false;
  if (roll.bonusDice.length !== spec.bonusDice.length) return false;
  if (roll.bonusDice.some((bonus, index) => bonus.source !== spec.bonusDice[index]?.source)) return false;
  return roll.total === d20.total + bonusTotal(roll.bonusDice);
}

// How natural 20s and 1s affect ability checks and saving throws. The 2014
// rules give them no special effect; "automatic" is a common house rule.
// Attacks and death saves always follow their own rules.
export type NaturalRollRule = "no-effect" | "automatic";

export interface D20TestOutcome {
  readonly success: boolean;
  // Set when the natural roll alone decided the outcome.
  readonly decidedByNatural: "natural20" | "natural1" | null;
  // Attacks only: a natural 20 is a critical hit.
  readonly critical: boolean;
}

export function resolveD20Test(
  kind: D20TestKind,
  natural: number,
  total: number,
  target: number,
  naturalRule: NaturalRollRule,
): D20TestOutcome {
  const naturalDecides = kind === "attack" || kind === "deathSave" || naturalRule === "automatic";
  if (naturalDecides && natural === 20) return { success: true, decidedByNatural: "natural20", critical: kind === "attack" };
  if (naturalDecides && natural === 1) return { success: false, decidedByNatural: "natural1", critical: false };
  return { success: total >= target, decidedByNatural: null, critical: false };
}
