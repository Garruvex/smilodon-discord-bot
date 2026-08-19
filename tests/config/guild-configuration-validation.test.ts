import { describe, expect, it } from "vitest";

import { validateGuildConfigurationText } from "../../src/config/guild-configuration-validation.js";

const validYaml = `
schemaVersion: 1
guild:
  id: "123456789012345678"
  name: Test Guild
channels:
  controlPanel: "234567890123456789"
`;

describe("validateGuildConfigurationText", () => {
  it("accepts a minimal valid guild configuration", () => {
    const result = validateGuildConfigurationText(validYaml);
    expect(result.valid).toBe(true);
    expect(result.guildId).toBe("123456789012345678");
    expect(result.errors).toEqual([]);
  });

  it("reports YAML parse errors without throwing", () => {
    const result = validateGuildConfigurationText("guild: [unterminated");
    expect(result.valid).toBe(false);
    expect(result.guildId).toBeNull();
    expect(result.errors[0]).toContain("Unable to parse YAML");
  });

  it("reports schema validation errors with field paths", () => {
    const result = validateGuildConfigurationText("schemaVersion: 1\n");
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.startsWith("guild:"))).toBe(true);
  });
});
