import { describe, expect, it } from "vitest";

import { rollDice } from "../../src/domain/games/dice.js";

describe("rollDice", () => {
  it("rolls the requested number of dice within range", () => {
    const { rolls, total } = rollDice(6, 5);
    expect(rolls).toHaveLength(5);
    for (const roll of rolls) {
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(6);
    }
    expect(total).toBe(rolls.reduce((sum, roll) => sum + roll, 0));
  });

  it("supports a single die", () => {
    const { rolls, total } = rollDice(20, 1);
    expect(rolls).toHaveLength(1);
    expect(total).toBe(rolls[0]);
  });
});
