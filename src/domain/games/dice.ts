export interface DiceRollResult {
  rolls: readonly number[];
  total: number;
}

export function rollDice(sides: number, count: number): DiceRollResult {
  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((sum, roll) => sum + roll, 0);
  return { rolls, total };
}
