import { describe, expect, it } from "vitest";

import { toGuildConfiguration } from "../../src/config/guild-configuration-document.js";
import { guildConfigurationFileSchema } from "../../src/config/guild-configuration-schema.js";
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

  describe("language", () => {
    const minimal = {
      schemaVersion: 1,
      guild: { id: "123456789012345678", name: "Test Guild" },
      channels: { controlPanel: "234567890123456789" },
    };

    it("defaults to English for configurations saved before the setting existed", () => {
      const configuration = toGuildConfiguration(guildConfigurationFileSchema.parse(minimal), "test.yaml");
      expect(configuration.language).toBe("en");
    });

    it("accepts each supported language and carries it into the configuration", () => {
      for (const language of ["en", "zh-TW", "ja"] as const) {
        const parsed = guildConfigurationFileSchema.parse({ ...minimal, language });
        expect(toGuildConfiguration(parsed, "test.yaml").language).toBe(language);
      }
    });

    it("rejects a language the bot doesn't have, naming the field", () => {
      const result = validateGuildConfigurationText(`${validYaml}language: fr\n`);
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.startsWith("language:"))).toBe(true);
    });
  });
});
