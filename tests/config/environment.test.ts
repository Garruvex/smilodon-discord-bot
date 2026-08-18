import { describe, expect, it } from "vitest";

import { loadConfiguration } from "../../src/config/environment.js";

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "warn",
  DISCORD_TOKEN: "test-token",
  DISCORD_APPLICATION_ID: "123456789012345678",
  BOT_OWNER_IDS: "345678901234567890, 456789012345678901",
  GUILD_CONFIG_DIRECTORY: "./config/local/guilds",
  RUNTIME_DATA_DIRECTORY: "./data/local",
  LAVALINK_HOST: "localhost",
  LAVALINK_PORT: "2333",
  LAVALINK_PASSWORD: "test-password",
  LAVALINK_SECURE: "false",
};

describe("loadConfiguration", () => {
  it("parses snowflake lists into sets", () => {
    const configuration = loadConfiguration(validEnvironment);

    expect(configuration.ownerUserIds).toEqual(
      new Set(["345678901234567890", "456789012345678901"]),
    );
    expect(configuration.guildConfigurationDirectory).toBe(
      "./config/local/guilds",
    );
  });

  it("rejects a malformed owner identifier", () => {
    expect(() =>
      loadConfiguration({
        ...validEnvironment,
        BOT_OWNER_IDS: "not-a-snowflake",
      }),
    ).toThrow("Invalid application configuration");
  });

  it("rejects missing Discord credentials", () => {
    expect(() => loadConfiguration({ NODE_ENV: "test" })).toThrow(
      "Invalid application configuration",
    );
  });

  it("requires a database URL for PostgreSQL persistence", () => {
    expect(() =>
      loadConfiguration({ ...validEnvironment, PERSISTENCE_DRIVER: "postgres" }),
    ).toThrow("DATABASE_URL is required");
  });

  it("accepts PostgreSQL persistence with a database URL", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      PERSISTENCE_DRIVER: "postgres",
      DATABASE_URL: "postgresql://user:password@localhost:5432/database",
    });

    expect(configuration.persistence.driver).toBe("postgres");
  });

  it("loads instance-level chat generation settings", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      CHAT_API_KEY: "secret",
      CHAT_BASE_URL: "https://api.openai.com/v1",
      CHAT_MODEL: "gpt-5-nano-2025-08-07",
      CHAT_API_MODE: "responses",
      CHAT_REASONING_EFFORT: "minimal",
      CHAT_VERBOSITY: "medium",
      CHAT_MAX_OUTPUT_TOKENS: "1024",
    });

    expect(configuration.chat).toMatchObject({
      mode: "responses",
      reasoningEffort: "minimal",
      verbosity: "medium",
      maxOutputTokens: 1_024,
    });
  });
});
