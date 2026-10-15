import { expect, it } from "vitest";
import { fadingWeight } from "../../src/application/memory/fading.js";
it("decays smoothly across the former expiry boundary without changing evidence age", () => {
  const weights = [89, 90, 91, 365].map((day) => fadingWeight(day * 86_400_000, 0, 30));
  expect(weights[0]).toBeGreaterThan(weights[1]!);
  expect(weights[1]).toBeCloseTo(0.125);
  expect(weights[2]! / weights[1]!).toBeCloseTo(2 ** (-1 / 30));
  expect(weights[3]).toBeGreaterThan(0);
  expect(fadingWeight(0, 1000, 30)).toBe(1);
});
