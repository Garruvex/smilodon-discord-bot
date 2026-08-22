import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "../../src/application/concurrency/map-with-concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves input order while bounding active transforms", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => { setTimeout(resolve, value % 2); });
      active -= 1;
      return value * 10;
    });

    expect(maximumActive).toBe(2);
    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("rejects invalid concurrency", async () => {
    await expect(mapWithConcurrency([1], 0, (value) => Promise.resolve(value))).rejects.toThrow(
      "Concurrency must be a positive integer",
    );
  });
});
