import { describe, expect, it } from "vitest";

import { estimatePersonaBundleOutputTokens } from "../../src/infrastructure/chat/persona-bundle-compilation.js";

describe("estimatePersonaBundleOutputTokens", () => {
  it("never returns less than the floor, even for an empty file", () => {
    expect(estimatePersonaBundleOutputTokens("")).toBe(4_000);
  });

  it("scales up for a large file well past the floor", () => {
    const large = "a".repeat(30_000);

    expect(estimatePersonaBundleOutputTokens(large)).toBeGreaterThan(10_000);
  });

  it("never exceeds the ceiling", () => {
    const huge = "a".repeat(500_000);

    expect(estimatePersonaBundleOutputTokens(huge)).toBe(32_000);
  });

  it("stays within the ceiling even for the largest allowed upload", () => {
    const maxUpload = "a".repeat(64 * 1024);

    expect(estimatePersonaBundleOutputTokens(maxUpload)).toBeLessThanOrEqual(32_000);
    expect(estimatePersonaBundleOutputTokens(maxUpload)).toBeGreaterThan(20_000);
  });
});
