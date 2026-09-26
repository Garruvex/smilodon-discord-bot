import { describe, expect, it } from "vitest";

import { dice, plus } from "../../../src/domain/campaign/dice/dice-expression.js";
import type { RandomSource } from "../../../src/domain/campaign/dice/random-source.js";
import { resolveRollMode, rollD20, rollExpression } from "../../../src/domain/campaign/dice/roll.js";

// Returns the given values in order and records every requested range.
function scripted(...values: number[]): RandomSource & { requests: [number, number][] } {
  const queue = [...values];
  const requests: [number, number][] = [];
  return {
    requests,
    nextInt(min: number, max: number): number {
      requests.push([min, max]);
      const value = queue.shift();
      if (value === undefined) throw new Error("Scripted random source ran out of values.");
      return value;
    },
  };
}

describe("rollExpression", () => {
  it("rolls each die and adds the modifier", () => {
    const source = scripted(3, 7);
    const roll = rollExpression(plus(dice(2, 8), 3), source);
    expect(roll.terms).toEqual([{ sides: 8, values: [3, 7] }]);
    expect(roll.total).toBe(13);
    expect(source.requests).toEqual([
      [1, 8],
      [1, 8],
    ]);
  });

  it("doubles the dice on a critical and records the doubled expression", () => {
    const roll = rollExpression(plus(dice(1, 8), 3), scripted(2, 5), { critical: true });
    expect(roll.expression).toEqual({ terms: [{ count: 2, sides: 8 }], modifier: 3 });
    expect(roll.total).toBe(10);
  });

  it("rejects a random source that returns an impossible face", () => {
    expect(() => rollExpression(dice(1, 6), scripted(7))).toThrow(RangeError);
    expect(() => rollExpression(dice(1, 6), scripted(0))).toThrow(RangeError);
  });
});

describe("rollD20", () => {
  it("rolls once for a normal roll", () => {
    const roll = rollD20("normal", 5, scripted(12));
    expect(roll).toMatchObject({ values: [12], natural: 12, total: 17 });
  });

  it("keeps the higher die with advantage and the lower with disadvantage", () => {
    expect(rollD20("advantage", 2, scripted(4, 15))).toMatchObject({ values: [4, 15], natural: 15, total: 17 });
    expect(rollD20("disadvantage", 2, scripted(4, 15))).toMatchObject({ values: [4, 15], natural: 4, total: 6 });
  });
});

describe("resolveRollMode", () => {
  it("cancels advantage and disadvantage regardless of how many sources each has", () => {
    expect(resolveRollMode(0, 0)).toBe("normal");
    expect(resolveRollMode(2, 0)).toBe("advantage");
    expect(resolveRollMode(0, 3)).toBe("disadvantage");
    expect(resolveRollMode(3, 1)).toBe("normal");
  });
});
