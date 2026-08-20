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

const fallbackModelsList = z
  .string()
  .default("")
  .transform((value) => value.split(",").map((item) => item.trim()).filter((item) => item.length > 0));

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
  // Opt-in — see ApplicationConfiguration.persistence.schemaPerInstance.
  PERSISTENCE_SCHEMA_PER_INSTANCE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  LAVALINK_HOST: z.string().min(1).default("127.0.0.1"),
  LAVALINK_PORT: z.coerce.number().int().min(1).max(65_535).default(2333),
  LAVALINK_PASSWORD: z.string().min(1),
  LAVALINK_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // The main chatbot persona/reply model. Renamed from CHAT_* — see
  // buildChatConfiguration. Sibling namespace UTILITY_* below is the
  // separate, optional, fully-independent provider for the standalone
  // structured-output calls (analyzeUserCustomization, summarizeDroppedExchanges).
  CHATBOT_API_KEY: optionalNonEmptyString,
  CHATBOT_BASE_URL: optionalUrl,
  CHATBOT_MODEL: optionalNonEmptyString,
  // Ordered fallback models tried (in this order) after the primary when it
  // hits a 429/quota error — see ModelFallbackChain. Optional; primary-only
  // behavior is unchanged when unset.
  CHATBOT_FALLBACK_MODELS: fallbackModelsList,
  // Optional cheaper/smaller model for the two standalone structured-output
  // calls that aren't a chat reply (analyzeUserCustomization,
  // summarizeDroppedExchanges) — low-stakes, low-context extraction tasks
  // that don't need the primary reply model's quality. Unset means those
  // calls keep using the primary CHATBOT_MODEL/CHATBOT_FALLBACK_MODELS chain.
  // Superseded by UTILITY_* when that's configured (see buildUtilityChatConfiguration).
  CHATBOT_SUMMARY_MODEL: optionalNonEmptyString,
  CHATBOT_SUMMARY_FALLBACK_MODELS: fallbackModelsList,
  CHATBOT_API_MODE: z.enum(["chat_completions", "responses", "gemini"]).default("chat_completions"),
  CHATBOT_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  CHATBOT_VERBOSITY: z.enum(["low", "medium", "high"]).default("low"),
  CHATBOT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(128_000).default(2_048),
  // Optional: enables vector-assisted guild-knowledge recall (see
  // EmbeddingGuildMemorySelector) via the same chat.baseUrl/chat.apiKey
  // credentials. Unset means the existing keyword-only selector is used.
  CHATBOT_EMBEDDING_MODEL: optionalNonEmptyString,
  // Gemini-only. 0 = thinking disabled, -1 = automatic; unset leaves the
  // model's own default budget in place — see GeminiChatProvider.
  CHATBOT_GEMINI_THINKING_BUDGET: z.coerce.number().int().min(-1).max(32_768).optional(),

  // Fully independent provider for the two standalone structured-output
  // calls (analyzeUserCustomization, summarizeDroppedExchanges) — own
  // credentials, own model, can be an entirely different provider type from
  // CHATBOT_*. All optional; leaving every UTILITY_* var unset falls back to
  // CHATBOT_*'s own summary-model routing (CHATBOT_SUMMARY_MODEL), which in
  // turn falls back to the primary CHATBOT_MODEL chain — three-tier, no
  // required config change for anyone not using this.
  UTILITY_API_KEY: optionalNonEmptyString,
  UTILITY_BASE_URL: optionalUrl,
  UTILITY_MODEL: optionalNonEmptyString,
  UTILITY_FALLBACK_MODELS: fallbackModelsList,
  UTILITY_API_MODE: z.enum(["chat_completions", "responses", "gemini"]).default("chat_completions"),
  UTILITY_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  UTILITY_VERBOSITY: z.enum(["low", "medium", "high"]).default("low"),
  UTILITY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(128_000).default(2_048),
  UTILITY_GEMINI_THINKING_BUDGET: z.coerce.number().int().min(-1).max(32_768).optional(),
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

  requireProviderFieldsTogether(
    "CHATBOT",
    parsed.data.CHATBOT_API_KEY,
    parsed.data.CHATBOT_BASE_URL,
    parsed.data.CHATBOT_MODEL,
    parsed.data.CHATBOT_API_MODE,
  );
  requireProviderFieldsTogether(
    "UTILITY",
    parsed.data.UTILITY_API_KEY,
    parsed.data.UTILITY_BASE_URL,
    parsed.data.UTILITY_MODEL,
    parsed.data.UTILITY_API_MODE,
  );

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
      schemaPerInstance: parsed.data.PERSISTENCE_SCHEMA_PER_INSTANCE,
    },
    lavalink: {
      host: parsed.data.LAVALINK_HOST,
      port: parsed.data.LAVALINK_PORT,
      password: parsed.data.LAVALINK_PASSWORD,
      secure: parsed.data.LAVALINK_SECURE,
    },
    chat: buildChatConfiguration(parsed.data),
    utilityChat: buildUtilityChatConfiguration(parsed.data),
  };
}

// CHATBOT_BASE_URL/UTILITY_BASE_URL are meaningless for Gemini — the SDK
// manages its own endpoint — so it's excluded from the "configured together"
// requirement in that mode, but still required for the two OpenAI-shaped modes.
function requireProviderFieldsTogether(
  namespace: "CHATBOT" | "UTILITY",
  apiKey: string | undefined,
  baseUrl: string | undefined,
  model: string | undefined,
  apiMode: "chat_completions" | "responses" | "gemini",
): void {
  const requiresBaseUrl = apiMode !== "gemini";
  const values = [apiKey, ...(requiresBaseUrl ? [baseUrl] : []), model];
  if (values.some(Boolean) && !values.every(Boolean)) {
    throw new Error(
      requiresBaseUrl
        ? `Invalid application configuration: ${namespace}_API_KEY, ${namespace}_BASE_URL, and ${namespace}_MODEL must be configured together`
        : `Invalid application configuration: ${namespace}_API_KEY and ${namespace}_MODEL must be configured together`,
    );
  }
}

function buildChatConfiguration(
  data: z.infer<typeof environmentSchema>,
): ApplicationConfiguration["chat"] {
  if (!data.CHATBOT_API_KEY || !data.CHATBOT_MODEL) return null;
  const models = [data.CHATBOT_MODEL, ...data.CHATBOT_FALLBACK_MODELS];
  // Falls back to the primary chain when unset, so leaving
  // CHATBOT_SUMMARY_MODEL unconfigured is byte-for-byte today's behavior.
  const summaryModels = data.CHATBOT_SUMMARY_MODEL
    ? [data.CHATBOT_SUMMARY_MODEL, ...data.CHATBOT_SUMMARY_FALLBACK_MODELS]
    : models;
  const embeddingModel = data.CHATBOT_EMBEDDING_MODEL ?? null;
  const maxOutputTokens = data.CHATBOT_MAX_OUTPUT_TOKENS;

  if (data.CHATBOT_API_MODE === "gemini") {
    return {
      provider: "gemini",
      apiKey: data.CHATBOT_API_KEY,
      models,
      summaryModels,
      maxOutputTokens,
      thinkingBudget: data.CHATBOT_GEMINI_THINKING_BUDGET ?? null,
      embeddingModel,
    };
  }
  if (!data.CHATBOT_BASE_URL) return null;
  const baseUrl = data.CHATBOT_BASE_URL.replace(/\/$/, "");
  if (data.CHATBOT_API_MODE === "responses") {
    return {
      provider: "openai-responses",
      apiKey: data.CHATBOT_API_KEY,
      baseUrl,
      models,
      summaryModels,
      reasoningEffort: data.CHATBOT_REASONING_EFFORT,
      verbosity: data.CHATBOT_VERBOSITY,
      maxOutputTokens,
      embeddingModel,
    };
  }
  return {
    provider: "openai-compatible",
    apiKey: data.CHATBOT_API_KEY,
    baseUrl,
    models,
    summaryModels,
    maxOutputTokens,
    embeddingModel,
  };
}

// Mirrors buildChatConfiguration's shape/branching but for the fully
// independent UTILITY_* provider — no summaryModels/embeddingModel here,
// since this config block IS the summary/utility model; it doesn't need
// further sub-routing, and embeddings stay tied to the main chatbot config.
function buildUtilityChatConfiguration(
  data: z.infer<typeof environmentSchema>,
): ApplicationConfiguration["utilityChat"] {
  if (!data.UTILITY_API_KEY || !data.UTILITY_MODEL) return null;
  const models = [data.UTILITY_MODEL, ...data.UTILITY_FALLBACK_MODELS];
  const maxOutputTokens = data.UTILITY_MAX_OUTPUT_TOKENS;

  if (data.UTILITY_API_MODE === "gemini") {
    return {
      provider: "gemini",
      apiKey: data.UTILITY_API_KEY,
      models,
      maxOutputTokens,
      thinkingBudget: data.UTILITY_GEMINI_THINKING_BUDGET ?? null,
    };
  }
  if (!data.UTILITY_BASE_URL) return null;
  const baseUrl = data.UTILITY_BASE_URL.replace(/\/$/, "");
  if (data.UTILITY_API_MODE === "responses") {
    return {
      provider: "openai-responses",
      apiKey: data.UTILITY_API_KEY,
      baseUrl,
      models,
      reasoningEffort: data.UTILITY_REASONING_EFFORT,
      verbosity: data.UTILITY_VERBOSITY,
      maxOutputTokens,
    };
  }
  return {
    provider: "openai-compatible",
    apiKey: data.UTILITY_API_KEY,
    baseUrl,
    models,
    maxOutputTokens,
  };
}
