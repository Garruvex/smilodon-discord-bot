import { describe, expect, it } from "vitest";

import { buildLyricsCacheKey } from "../../src/application/lyrics/lyrics-cache-store.js";

describe("buildLyricsCacheKey", () => {
  it("keeps title and artist fields distinct when either contains a separator", () => {
    const first = buildLyricsCacheKey("A|B", "C", 200_000);
    const second = buildLyricsCacheKey("A", "B|C", 200_000);

    expect(first).not.toBe(second);
  });
});
