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
    expect(configuration.persistence.schemaPerInstance).toBe(false);
  });

  it("defaults schema-per-instance to false and honors an explicit opt-in", () => {
    const defaulted = loadConfiguration(validEnvironment);
    expect(defaulted.persistence.schemaPerInstance).toBe(false);

    const optedIn = loadConfiguration({
      ...validEnvironment,
      PERSISTENCE_DRIVER: "postgres",
      DATABASE_URL: "postgresql://user:password@localhost:5432/database",
      PERSISTENCE_SCHEMA_PER_INSTANCE: "true",
    });
    expect(optedIn.persistence.schemaPerInstance).toBe(true);
  });

  it("loads instance-level chat generation settings", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      CHATBOT_API_KEY: "secret",
      CHATBOT_BASE_URL: "https://api.openai.com/v1",
      CHATBOT_MODEL: "gpt-5-nano-2025-08-07",
      CHATBOT_API_MODE: "responses",
      CHATBOT_REASONING_EFFORT: "minimal",
      CHATBOT_VERBOSITY: "medium",
      CHATBOT_MAX_OUTPUT_TOKENS: "1024",
    });

    expect(configuration.chat).toMatchObject({
      provider: "openai-responses",
      reasoningEffort: "minimal",
      verbosity: "medium",
      maxOutputTokens: 1_024,
    });
  });

  it("loads a Gemini chat configuration without requiring CHATBOT_BASE_URL", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      CHATBOT_API_KEY: "secret",
      CHATBOT_MODEL: "gemini-3.6-flash",
      CHATBOT_API_MODE: "gemini",
      CHATBOT_MAX_OUTPUT_TOKENS: "1024",
      CHATBOT_GEMINI_THINKING_BUDGET: "512",
    });

    expect(configuration.chat).toMatchObject({
      provider: "gemini",
      apiKey: "secret",
      models: ["gemini-3.6-flash"],
      maxOutputTokens: 1_024,
      thinkingBudget: 512,
    });
  });

  it("defaults Gemini thinkingBudget to null when unset", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      CHATBOT_API_KEY: "secret",
      CHATBOT_MODEL: "gemini-3.6-flash",
      CHATBOT_API_MODE: "gemini",
    });

    expect(configuration.chat).toMatchObject({ provider: "gemini", thinkingBudget: null });
  });

  it("still rejects a Gemini config missing CHATBOT_MODEL, even without CHATBOT_BASE_URL", () => {
    expect(() =>
      loadConfiguration({
        ...validEnvironment,
        CHATBOT_API_KEY: "secret",
        CHATBOT_API_MODE: "gemini",
      }),
    ).toThrow("CHATBOT_API_KEY and CHATBOT_MODEL must be configured together");
  });

  it("defaults summaryModels to the primary chain when CHATBOT_SUMMARY_MODEL is unset", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      CHATBOT_API_KEY: "secret",
      CHATBOT_BASE_URL: "https://api.openai.com/v1",
      CHATBOT_MODEL: "gpt-5-nano",
      CHATBOT_FALLBACK_MODELS: "gpt-5-mini",
      CHATBOT_API_MODE: "responses",
    });

    expect(configuration.chat).toMatchObject({ summaryModels: ["gpt-5-nano", "gpt-5-mini"] });
  });

  it("uses a separate summary model chain when CHATBOT_SUMMARY_MODEL is set", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      CHATBOT_API_KEY: "secret",
      CHATBOT_BASE_URL: "https://api.openai.com/v1",
      CHATBOT_MODEL: "gpt-5-nano",
      CHATBOT_API_MODE: "responses",
      CHATBOT_SUMMARY_MODEL: "gpt-5-mini",
      CHATBOT_SUMMARY_FALLBACK_MODELS: "gpt-5-nano",
    });

    expect(configuration.chat).toMatchObject({ summaryModels: ["gpt-5-mini", "gpt-5-nano"] });
  });

  it("defaults utilityChat to null when no UTILITY_* vars are set", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      CHATBOT_API_KEY: "secret",
      CHATBOT_BASE_URL: "https://api.openai.com/v1",
      CHATBOT_MODEL: "gpt-5-nano",
      CHATBOT_API_MODE: "responses",
    });

    expect(configuration.utilityChat).toBeNull();
  });

  it("loads a fully independent utility provider, distinct from the main chatbot config", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      CHATBOT_API_KEY: "chatbot-secret",
      CHATBOT_BASE_URL: "https://api.openai.com/v1",
      CHATBOT_MODEL: "gpt-5-nano",
      CHATBOT_API_MODE: "responses",
      UTILITY_API_KEY: "utility-secret",
      UTILITY_BASE_URL: "https://openrouter.example/v1",
      UTILITY_MODEL: "cheap-model",
      UTILITY_API_MODE: "chat_completions",
    });

    expect(configuration.utilityChat).toMatchObject({
      provider: "openai-compatible",
      apiKey: "utility-secret",
      baseUrl: "https://openrouter.example/v1",
      models: ["cheap-model"],
    });
    // Distinct from the main chatbot provider's own credentials/model.
    expect(configuration.chat).toMatchObject({ apiKey: "chatbot-secret", models: ["gpt-5-nano"] });
  });

  it("rejects a partially-configured utility provider", () => {
    expect(() =>
      loadConfiguration({
        ...validEnvironment,
        UTILITY_API_KEY: "secret",
        UTILITY_API_MODE: "chat_completions",
      }),
    ).toThrow("UTILITY_API_KEY, UTILITY_BASE_URL, and UTILITY_MODEL must be configured together");
  });
});
