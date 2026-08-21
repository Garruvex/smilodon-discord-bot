import { describe, expect, it } from "vitest";

import { loadConfiguration } from "../../src/config/environment.js";

const validEnvironment: NodeJS.ProcessEnv = {
  INSTANCE_NAME: "test-instance",
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
  it("allows Gemini chat with independent OpenAI embeddings", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      GOOGLE_API_KEY: "google-secret",
      OPENAI_API_KEY: "openai-secret",
      CHATBOT_MODEL: "gemini-2.5-flash",
      CHATBOT_PROVIDER: "gemini",
      EMBEDDING_PROVIDER: "openai",
      EMBEDDING_MODEL: "text-embedding-3-small",
    });

    expect(configuration.chat?.provider).toBe("gemini");
    expect(configuration.embeddings).toMatchObject({
      provider: "openai", model: "text-embedding-3-small", apiKey: "openai-secret",
    });
  });

  it("allows OpenAI chat with independent Gemini embeddings", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      GOOGLE_API_KEY: "google-secret",
      OPENAI_API_KEY: "openai-secret",
      CHATBOT_MODEL: "gpt-5-nano",
      CHATBOT_PROVIDER: "openai",
      EMBEDDING_PROVIDER: "gemini",
      EMBEDDING_MODEL: "gemini-embedding-001",
    });

    expect(configuration.embeddings).toEqual({
      provider: "gemini", model: "gemini-embedding-001", apiKey: "google-secret",
    });
  });

  it("requires the embedding provider's credential", () => {
    expect(() => loadConfiguration({
      ...validEnvironment,
      EMBEDDING_PROVIDER: "gemini",
      EMBEDDING_MODEL: "gemini-embedding-001",
    })).toThrow("GOOGLE_API_KEY is required");
  });

  it("keeps legacy CHATBOT_EMBEDDING_MODEL as an OpenAI configuration", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      OPENAI_API_KEY: "openai-secret",
      CHATBOT_EMBEDDING_MODEL: "text-embedding-3-small",
    });
    expect(configuration.embeddings?.provider).toBe("openai");
  });

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
    expect(configuration.instanceName).toBe("test-instance");
  });

  it("requires an instance name for PostgreSQL schema isolation", () => {
    expect(() => loadConfiguration({
      ...validEnvironment,
      INSTANCE_NAME: undefined,
      PERSISTENCE_DRIVER: "postgres",
      DATABASE_URL: "postgresql://user:password@localhost:5432/database",
    })).toThrow("INSTANCE_NAME is required");
  });

  it("loads instance-level chat generation settings, using OPENAI_API_KEY/OPENAI_BASE_URL", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      OPENAI_API_KEY: "secret",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      CHATBOT_MODEL: "gpt-5-nano-2025-08-07",
      CHATBOT_PROVIDER: "openai",
      CHATBOT_MODE: "responses",
      CHATBOT_REASONING_EFFORT: "minimal",
      CHATBOT_VERBOSITY: "medium",
      CHATBOT_MAX_OUTPUT_TOKENS: "1024",
    });

    expect(configuration.chat).toMatchObject({
      provider: "openai-responses",
      apiKey: "secret",
      baseUrl: "https://api.openai.com/v1",
      reasoningEffort: "minimal",
      verbosity: "medium",
      maxOutputTokens: 1_024,
    });
  });

  it("defaults OPENAI_BASE_URL to the official API when unset", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      OPENAI_API_KEY: "secret",
      CHATBOT_MODEL: "gpt-5-nano",
      CHATBOT_MODE: "chat_completions",
    });

    expect(configuration.chat).toMatchObject({ baseUrl: "https://api.openai.com/v1" });
  });

  it("loads a Gemini chat configuration from GOOGLE_API_KEY, no OPENAI_* required", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      GOOGLE_API_KEY: "secret",
      CHATBOT_MODEL: "gemini-3.6-flash",
      CHATBOT_PROVIDER: "gemini",
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
      GOOGLE_API_KEY: "secret",
      CHATBOT_MODEL: "gemini-3.6-flash",
      CHATBOT_PROVIDER: "gemini",
    });

    expect(configuration.chat).toMatchObject({ provider: "gemini", thinkingBudget: null });
  });

  it("leaves chat disabled (null) when CHATBOT_MODEL is unset, even with keys present", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      OPENAI_API_KEY: "secret",
      GOOGLE_API_KEY: "secret",
    });

    expect(configuration.chat).toBeNull();
  });

  it("rejects CHATBOT_PROVIDER=gemini with CHATBOT_MODEL set but no GOOGLE_API_KEY", () => {
    expect(() =>
      loadConfiguration({
        ...validEnvironment,
        CHATBOT_MODEL: "gemini-3.6-flash",
        CHATBOT_PROVIDER: "gemini",
      }),
    ).toThrow("GOOGLE_API_KEY is required when CHATBOT_PROVIDER=gemini and CHATBOT_MODEL is set");
  });

  it("rejects CHATBOT_PROVIDER=openai with CHATBOT_MODEL set but no OPENAI_API_KEY", () => {
    expect(() =>
      loadConfiguration({
        ...validEnvironment,
        CHATBOT_MODEL: "gpt-5-nano",
      }),
    ).toThrow("OPENAI_API_KEY is required when CHATBOT_PROVIDER=openai and CHATBOT_MODEL is set");
  });

  it("rejects CHATBOT_MODE when CHATBOT_PROVIDER=gemini", () => {
    expect(() =>
      loadConfiguration({
        ...validEnvironment,
        GOOGLE_API_KEY: "secret",
        CHATBOT_MODEL: "gemini-3.6-flash",
        CHATBOT_PROVIDER: "gemini",
        CHATBOT_MODE: "responses",
      }),
    ).toThrow("CHATBOT_MODE is not applicable when CHATBOT_PROVIDER=gemini");
  });

  it("rejects CHATBOT_GEMINI_THINKING_BUDGET when CHATBOT_PROVIDER=openai", () => {
    expect(() =>
      loadConfiguration({
        ...validEnvironment,
        OPENAI_API_KEY: "secret",
        CHATBOT_MODEL: "gpt-5-nano",
        CHATBOT_PROVIDER: "openai",
        CHATBOT_GEMINI_THINKING_BUDGET: "512",
      }),
    ).toThrow("CHATBOT_GEMINI_THINKING_BUDGET is only applicable when CHATBOT_PROVIDER=gemini");
  });

  it("defaults summaryModels to the primary chain when CHATBOT_SUMMARY_MODEL is unset", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      OPENAI_API_KEY: "secret",
      CHATBOT_MODEL: "gpt-5-nano",
      CHATBOT_FALLBACK_MODELS: "gpt-5-mini",
      CHATBOT_MODE: "responses",
    });

    expect(configuration.chat).toMatchObject({ summaryModels: ["gpt-5-nano", "gpt-5-mini"] });
  });

  it("uses a separate summary model chain when CHATBOT_SUMMARY_MODEL is set", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      OPENAI_API_KEY: "secret",
      CHATBOT_MODEL: "gpt-5-nano",
      CHATBOT_MODE: "responses",
      CHATBOT_SUMMARY_MODEL: "gpt-5-mini",
      CHATBOT_SUMMARY_FALLBACK_MODELS: "gpt-5-nano",
      CHATBOT_SUMMARY_REASONING_EFFORT: "minimal",
      CHATBOT_SUMMARY_MAX_OUTPUT_TOKENS: "4096",
    });

    expect(configuration.chat).toMatchObject({
      summaryModels: ["gpt-5-mini", "gpt-5-nano"],
      summaryReasoningEffort: "minimal",
      summaryMaxOutputTokens: 4_096,
    });
  });

  it("defaults utilityChat to null when UTILITY_MODEL is unset", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      OPENAI_API_KEY: "secret",
      CHATBOT_MODEL: "gpt-5-nano",
      CHATBOT_MODE: "responses",
    });

    expect(configuration.utilityChat).toBeNull();
  });

  it("loads an independent utility model on Gemini while main chat stays on OpenAI, sharing one key pool", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      OPENAI_API_KEY: "openai-secret",
      CHATBOT_MODEL: "gpt-5-nano",
      CHATBOT_MODE: "responses",
      GOOGLE_API_KEY: "google-secret",
      UTILITY_MODEL: "gemini-3.5-flash",
      UTILITY_PROVIDER: "gemini",
    });

    expect(configuration.utilityChat).toMatchObject({
      provider: "gemini",
      apiKey: "google-secret",
      models: ["gemini-3.5-flash"],
    });
    // Distinct from the main chatbot provider's own credentials/model.
    expect(configuration.chat).toMatchObject({ apiKey: "openai-secret", models: ["gpt-5-nano"] });
  });

  it("lets CHATBOT_* and UTILITY_* both use openai without duplicating the key", () => {
    const configuration = loadConfiguration({
      ...validEnvironment,
      OPENAI_API_KEY: "shared-secret",
      CHATBOT_MODEL: "gpt-5.6-luna",
      CHATBOT_MODE: "responses",
      UTILITY_MODEL: "gpt-5-nano",
      UTILITY_MODE: "chat_completions",
    });

    expect(configuration.chat).toMatchObject({ apiKey: "shared-secret", models: ["gpt-5.6-luna"] });
    expect(configuration.utilityChat).toMatchObject({
      provider: "openai-compatible",
      apiKey: "shared-secret",
      models: ["gpt-5-nano"],
    });
  });

  it("rejects UTILITY_PROVIDER=gemini with UTILITY_MODEL set but no GOOGLE_API_KEY", () => {
    expect(() =>
      loadConfiguration({
        ...validEnvironment,
        UTILITY_MODEL: "gemini-3.5-flash",
        UTILITY_PROVIDER: "gemini",
      }),
    ).toThrow("GOOGLE_API_KEY is required when UTILITY_PROVIDER=gemini and UTILITY_MODEL is set");
  });
});
