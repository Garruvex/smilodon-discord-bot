// Dice expressions such as "2d8 + 3", as data. Content definitions build
// these with dice()/plus()/combine(); parseDiceExpression() is for text that
// arrives from outside (tests, adventure files, organizer input) and returns
// null instead of throwing, because bad input there is not a programming
// error.

export const dieSizes = [4, 6, 8, 10, 12, 20, 100] as const;
export type DieSize = (typeof dieSizes)[number];

export interface DiceTerm {
  readonly count: number;
  readonly sides: DieSize;
}

export interface DiceExpression {
  // At most one term per die size, ordered by ascending size, so two equal
  // expressions always have the same shape and format the same way.
  readonly terms: readonly DiceTerm[];
  readonly modifier: number;
}

export const maxDicePerTerm = 100;
export const maxModifier = 1000;

export function isDieSize(value: number): value is DieSize {
  return (dieSizes as readonly number[]).includes(value);
}

export function dice(count: number, sides: DieSize): DiceExpression {
  assertCount(count);
  return { terms: [{ count, sides }], modifier: 0 };
}

export function flat(modifier: number): DiceExpression {
  assertModifier(modifier);
  return { terms: [], modifier };
}

export function plus(expression: DiceExpression, modifier: number): DiceExpression {
  const total = expression.modifier + modifier;
  assertModifier(total);
  return { terms: expression.terms, modifier: total };
}

export function combine(...expressions: readonly DiceExpression[]): DiceExpression {
  const counts = new Map<DieSize, number>();
  let modifier = 0;
  for (const expression of expressions) {
    for (const term of expression.terms) {
      counts.set(term.sides, (counts.get(term.sides) ?? 0) + term.count);
    }
    modifier += expression.modifier;
  }
  assertModifier(modifier);
  const terms = dieSizes
    .filter((sides) => counts.has(sides))
    .map((sides) => {
      const count = counts.get(sides) ?? 0;
      assertCount(count);
      return { count, sides };
    });
  return { terms, modifier };
}

// Multiplies the number of dice, not the modifier — the 2014 critical-hit
// rule ("roll all of the attack's damage dice twice").
export function multiplyDice(expression: DiceExpression, factor: number): DiceExpression {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new RangeError(`Dice multiplier must be a positive integer, got ${factor}.`);
  }
  return combine({
    terms: expression.terms.map((term) => ({ count: term.count * factor, sides: term.sides })),
    modifier: expression.modifier,
  });
}

export function minimumOf(expression: DiceExpression): number {
  return expression.terms.reduce((sum, term) => sum + term.count, 0) + expression.modifier;
}

export function maximumOf(expression: DiceExpression): number {
  return expression.terms.reduce((sum, term) => sum + term.count * term.sides, 0) + expression.modifier;
}

export function formatDiceExpression(expression: DiceExpression): string {
  if (expression.terms.length === 0) return String(expression.modifier);
  const dicePart = expression.terms.map((term) => `${term.count}d${term.sides}`).join(" + ");
  if (expression.modifier > 0) return `${dicePart} + ${expression.modifier}`;
  if (expression.modifier < 0) return `${dicePart} - ${-expression.modifier}`;
  return dicePart;
}

const termPattern = /^([+-])?(\d*)d(\d+)$|^([+-])?(\d+)$/;

export function parseDiceExpression(text: string): DiceExpression | null {
  const compact = text.replace(/\s+/g, "").toLowerCase();
  if (compact.length === 0) return null;
  // Split before every sign so "2d8+3-1d4" becomes ["2d8", "+3", "-1d4"].
  const tokens = compact.split(/(?=[+-])/);
  const parts: DiceExpression[] = [];
  for (const token of tokens) {
    const match = termPattern.exec(token);
    if (!match) return null;
    if (match[3] !== undefined) {
      if (match[1] === "-") return null; // subtracting dice is not a rules expression
      const count = match[2] === "" || match[2] === undefined ? 1 : Number(match[2]);
      const sides = Number(match[3]);
      if (!isDieSize(sides) || !isValidCount(count)) return null;
      parts.push({ terms: [{ count, sides }], modifier: 0 });
    } else {
      const value = Number(match[5]);
      parts.push({ terms: [], modifier: match[4] === "-" ? -value : value });
    }
  }
  return combineOrNull(parts);
}

function combineOrNull(parts: readonly DiceExpression[]): DiceExpression | null {
  try {
    return combine(...parts);
  } catch {
    return null;
  }
}

function isValidCount(count: number): boolean {
  return Number.isInteger(count) && count >= 1 && count <= maxDicePerTerm;
}

function assertCount(count: number): void {
  if (!isValidCount(count)) {
    throw new RangeError(`Dice count must be an integer from 1 to ${maxDicePerTerm}, got ${count}.`);
  }
}

function assertModifier(modifier: number): void {
  if (!Number.isInteger(modifier) || Math.abs(modifier) > maxModifier) {
    throw new RangeError(`Dice modifier must be an integer within ±${maxModifier}, got ${modifier}.`);
  }
}
