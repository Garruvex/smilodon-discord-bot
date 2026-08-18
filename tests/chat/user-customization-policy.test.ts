import { describe, expect, it } from "vitest";

import { userCustomizationLimits, validateUserCustomization } from "../../src/application/chat/user-customization-policy.js";

describe("validateUserCustomization", () => {
  it("rejects empty or whitespace-only input", () => {
    expect(validateUserCustomization("")).toEqual({ ok: false, reason: "Customization cannot be empty." });
    expect(validateUserCustomization("   \n  ")).toEqual({ ok: false, reason: "Customization cannot be empty." });
  });

  it("rejects input over the character limit", () => {
    const tooLong = "a".repeat(userCustomizationLimits.maxChars + 1);
    const result = validateUserCustomization(tooLong);
    expect(result.ok).toBe(false);
  });

  it("accepts and trims valid input", () => {
    const result = validateUserCustomization("  Call me 阿龍.\n\nBe more playful.  ");
    expect(result).toEqual({ ok: true, value: "Call me 阿龍.\n\nBe more playful." });
  });

  it("accepts input exactly at the character limit", () => {
    const atLimit = "a".repeat(userCustomizationLimits.maxChars);
    expect(validateUserCustomization(atLimit)).toEqual({ ok: true, value: atLimit });
  });
});
