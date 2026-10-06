import { dice, flat, isDieSize, plus, type DiceExpression } from "../../../dice/dice-expression.js";

// Dice by level, the way spells scale: keyed by slot level (or character level for a
// cantrip), each row [dice, sides, flat bonus]. The row for the highest key at or below the
// level asked for applies.
export type DiceTable = Readonly<Record<number, readonly [number, number, number]>>;

export function diceAt(table: DiceTable, level: number): DiceExpression {
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  const key = [...keys].reverse().find((candidate) => candidate <= level) ?? keys[0];
  const row = key === undefined ? undefined : table[key];
  if (row === undefined) return flat(0);
  const [count, sides, bonus] = row;
  if (count === 0 || !isDieSize(sides)) return flat(bonus);
  return bonus === 0 ? dice(count, sides) : plus(dice(count, sides), bonus);
}
