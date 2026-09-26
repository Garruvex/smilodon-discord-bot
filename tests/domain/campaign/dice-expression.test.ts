import { describe, expect, it } from "vitest";

import {
  combine,
  dice,
  flat,
  formatDiceExpression,
  maximumOf,
  minimumOf,
  multiplyDice,
  parseDiceExpression,
  plus,
} from "../../../src/domain/campaign/dice/dice-expression.js";

describe("dice expressions", () => {
  it("combines terms of the same die size and orders them by size", () => {
    const expression = combine(dice(1, 8), dice(1, 4), dice(2, 8), flat(3));
    expect(expression).toEqual({
      terms: [
        { count: 1, sides: 4 },
        { count: 3, sides: 8 },
      ],
      modifier: 3,
    });
  });

  it("formats expressions the way players read them", () => {
    expect(formatDiceExpression(plus(dice(2, 8), 3))).toBe("2d8 + 3");
    expect(formatDiceExpression(plus(dice(1, 20), -1))).toBe("1d20 - 1");
    expect(formatDiceExpression(combine(dice(1, 8), dice(1, 6)))).toBe("1d6 + 1d8");
    expect(formatDiceExpression(flat(5))).toBe("5");
  });

  it("doubles dice but not the modifier for critical hits", () => {
    expect(multiplyDice(plus(dice(1, 8), 3), 2)).toEqual({ terms: [{ count: 2, sides: 8 }], modifier: 3 });
  });

  it("computes minimum and maximum totals", () => {
    const expression = plus(dice(2, 6), 1);
    expect(minimumOf(expression)).toBe(3);
    expect(maximumOf(expression)).toBe(13);
  });

  it("parses common notations", () => {
    expect(parseDiceExpression("2d8+3")).toEqual(plus(dice(2, 8), 3));
    expect(parseDiceExpression(" d20 - 1 ")).toEqual(plus(dice(1, 20), -1));
    expect(parseDiceExpression("1d6 + 1d4 + 2")).toEqual(combine(dice(1, 6), dice(1, 4), flat(2)));
    expect(parseDiceExpression("7")).toEqual(flat(7));
  });

  it("rejects invalid notations instead of throwing", () => {
    for (const text of ["", "d", "2d7", "0d6", "101d6", "2d8+", "-1d6", "2x8", "3d6+2000"]) {
      expect(parseDiceExpression(text), text).toBeNull();
    }
  });

  it("rejects invalid dice built in code", () => {
    expect(() => dice(0, 6)).toThrow(RangeError);
    expect(() => dice(1.5, 6)).toThrow(RangeError);
    expect(() => plus(dice(1, 6), 0.5)).toThrow(RangeError);
    expect(() => multiplyDice(dice(1, 6), 0)).toThrow(RangeError);
  });
});
