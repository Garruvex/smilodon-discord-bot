import "dotenv/config";

import { z } from "zod";

import type { ApplicationConfiguration } from "./configuration.js";
import { resolveDefaultInstanceEnvironment } from "./instance-environment.js";

const discordSnowflake = /^\d{17,20}$/;
const optionalNonEmptyString = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().url().optional(),
);

const requiredSnowflakeList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(z.string().regex(discordSnowflake)).min(1));

const environmentSchema = z.object({
  INSTANCE_NAME: optionalNonEmptyString,
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().regex(discordSnowflake),
  BOT_OWNER_IDS: requiredSnowflakeList,
  GUILD_CONFIG_DIRECTORY: z.string().min(1).default("./config/local/guilds"),
  RUNTIME_DATA_DIRECTORY: z.string().min(1).default("./data/local"),
  PERSISTENCE_DRIVER: z.enum(["file", "postgres"]).default("file"),
  DATABASE_URL: z.string().url().optional(),
  LAVALINK_HOST: z.string().min(1).default("127.0.0.1"),
  LAVALINK_PORT: z.coerce.number().int().min(1).max(65_535).default(2333),
  LAVALINK_PASSWORD: z.string().min(1),
  LAVALINK_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CHAT_API_KEY: optionalNonEmptyString,
  CHAT_BASE_URL: optionalUrl,
  CHAT_MODEL: optionalNonEmptyString,
  CHAT_API_MODE: z.enum(["chat_completions", "responses"]).default("chat_completions"),
  CHAT_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  CHAT_VERBOSITY: z.enum(["low", "medium", "high"]).default("low"),
  CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(128_000).default(2_048),
});

export function loadConfiguration(
  source: NodeJS.ProcessEnv = process.env,
): ApplicationConfiguration {
  const parsed = environmentSchema.safeParse(resolveDefaultInstanceEnvironment(source));

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");

    throw new Error(`Invalid application configuration: ${details}`);
  }

  if (parsed.data.PERSISTENCE_DRIVER === "postgres" && !parsed.data.DATABASE_URL) {
    throw new Error(
      "Invalid application configuration: DATABASE_URL is required when PERSISTENCE_DRIVER=postgres",
    );
  }

  const chatValues = [
    parsed.data.CHAT_API_KEY,
    parsed.data.CHAT_BASE_URL,
    parsed.data.CHAT_MODEL,
  ];
  if (chatValues.some(Boolean) && !chatValues.every(Boolean)) {
    throw new Error(
      "Invalid application configuration: CHAT_API_KEY, CHAT_BASE_URL, and CHAT_MODEL must be configured together",
    );
  }

  return {
    instanceName: parsed.data.INSTANCE_NAME ?? null,
    environment: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    discord: {
      token: parsed.data.DISCORD_TOKEN,
      applicationId: parsed.data.DISCORD_APPLICATION_ID,
    },
    ownerUserIds: new Set(parsed.data.BOT_OWNER_IDS),
    guildConfigurationDirectory: parsed.data.GUILD_CONFIG_DIRECTORY,
    runtimeDataDirectory: parsed.data.RUNTIME_DATA_DIRECTORY,
    persistence: {
      driver: parsed.data.PERSISTENCE_DRIVER,
      databaseUrl: parsed.data.DATABASE_URL ?? null,
    },
    lavalink: {
      host: parsed.data.LAVALINK_HOST,
      port: parsed.data.LAVALINK_PORT,
      password: parsed.data.LAVALINK_PASSWORD,
      secure: parsed.data.LAVALINK_SECURE,
    },
    chat: parsed.data.CHAT_API_KEY && parsed.data.CHAT_BASE_URL && parsed.data.CHAT_MODEL
      ? {
          apiKey: parsed.data.CHAT_API_KEY,
          baseUrl: parsed.data.CHAT_BASE_URL.replace(/\/$/, ""),
          model: parsed.data.CHAT_MODEL,
          mode: parsed.data.CHAT_API_MODE,
          reasoningEffort: parsed.data.CHAT_REASONING_EFFORT,
          verbosity: parsed.data.CHAT_VERBOSITY,
          maxOutputTokens: parsed.data.CHAT_MAX_OUTPUT_TOKENS,
        }
      : null,
  };
}
