import "dotenv/config";

import { z } from "zod";

import type { ApplicationConfiguration } from "./configuration.js";
import {
  resolveDefaultInstanceEnvironment,
  resolveSharedPostgresEnvironment,
} from "./instance-environment.js";

const discordSnowflake = /^\d{17,20}$/;
const optionalNonEmptyString = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional(),
);
const openAiBaseUrlWithDefault = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().url().default("https://api.openai.com/v1"),
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
  LAVALINK_HOST: z.string().min(1).default("127.0.0.1"),
  LAVALINK_PORT: z.coerce.number().int().min(1).max(65_535).default(2333),
  LAVALINK_PASSWORD: z.string().min(1),
  LAVALINK_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // One API key per supported vendor, shared by both CHATBOT_* and UTILITY_*
  // below — whichever provider a task selects, its credential is looked up
  // here rather than duplicated per task. Both instance-scoped, like
  // CHATBOT_*/UTILITY_* (see instanceOwnedEnvironmentPrefixes).
  OPENAI_API_KEY: optionalNonEmptyString,
  // Override for an OpenAI-compatible third-party endpoint (OpenRouter,
  // self-hosted, etc.) instead of OpenAI's own API. Shared by every task
  // that selects PROVIDER=openai — there's one OpenAI-shaped endpoint per
  // instance, not one per task.
  OPENAI_BASE_URL: openAiBaseUrlWithDefault,
  GOOGLE_API_KEY: optionalNonEmptyString,

  // The main chatbot persona/reply model. Renamed from CHAT_* — see
  // buildChatConfiguration. Sibling namespace UTILITY_* below is the
  // separate, optional, fully-independent task for the standalone
  // structured-output calls (analyzeUserCustomization, summarizeDroppedExchanges).
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
  // Structured summary calls can use a different reasoning/output budget
  // from interactive replies. This matters for the Responses API because
  // max_output_tokens includes both hidden reasoning and visible JSON.
  CHATBOT_SUMMARY_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  CHATBOT_SUMMARY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(128_000).default(4_096),
  // Which vendor/protocol family to talk to. CHATBOT_MODE only applies (and
  // is only meaningful) when PROVIDER=openai — it picks the OpenAI wire
  // variant (generic Chat Completions vs. OpenAI's own Responses API).
  // Gemini has no such sub-variant, so CHATBOT_MODE is rejected when
  // PROVIDER=gemini rather than silently ignored — see validateProviderConfig.
  CHATBOT_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
  CHATBOT_MODE: z.enum(["chat_completions", "responses"]).optional(),
  CHATBOT_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  CHATBOT_VERBOSITY: z.enum(["low", "medium", "high"]).default("low"),
  CHATBOT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(128_000).default(2_048),
  // Legacy OpenAI-only model name. Prefer the provider-independent
  // EMBEDDING_PROVIDER and EMBEDDING_MODEL settings below.
  CHATBOT_EMBEDDING_MODEL: optionalNonEmptyString,
  // Provider-independent replacement for CHATBOT_EMBEDDING_MODEL. The
  // legacy name remains accepted as an OpenAI model for compatibility.
  EMBEDDING_MODEL: optionalNonEmptyString,
  EMBEDDING_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
  // Gemini-only. 0 = thinking disabled, -1 = automatic; unset leaves the
  // model's own default budget in place — see GeminiChatProvider.
  CHATBOT_GEMINI_THINKING_BUDGET: z.coerce.number().int().min(-1).max(32_768).optional(),

  // Fully independent task for the two standalone structured-output calls
  // (analyzeUserCustomization, summarizeDroppedExchanges) — own model, can be
  // an entirely different provider from CHATBOT_* (credentials still come
  // from the shared OPENAI_API_KEY/GOOGLE_API_KEY above). All optional;
  // leaving every UTILITY_* var unset falls back to CHATBOT_*'s own
  // summary-model routing (CHATBOT_SUMMARY_MODEL), which in turn falls back
  // to the primary CHATBOT_MODEL chain — three-tier, no required config
  // change for anyone not using this.
  UTILITY_MODEL: optionalNonEmptyString,
  UTILITY_FALLBACK_MODELS: fallbackModelsList,
  UTILITY_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
  UTILITY_MODE: z.enum(["chat_completions", "responses"]).optional(),
  UTILITY_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  UTILITY_VERBOSITY: z.enum(["low", "medium", "high"]).default("low"),
  UTILITY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(128_000).default(2_048),
  UTILITY_GEMINI_THINKING_BUDGET: z.coerce.number().int().min(-1).max(32_768).optional(),
});

export function loadConfiguration(
  source: NodeJS.ProcessEnv = process.env,
): ApplicationConfiguration {
  const parsed = environmentSchema.safeParse(
    resolveSharedPostgresEnvironment(resolveDefaultInstanceEnvironment(source)),
  );

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
  if (parsed.data.PERSISTENCE_DRIVER === "postgres" && !parsed.data.INSTANCE_NAME) {
    throw new Error(
      "Invalid application configuration: INSTANCE_NAME is required when PERSISTENCE_DRIVER=postgres",
    );
  }

  validateProviderConfig(
    "CHATBOT",
    parsed.data.CHATBOT_MODEL,
    parsed.data.CHATBOT_PROVIDER,
    parsed.data.CHATBOT_MODE,
    parsed.data.CHATBOT_GEMINI_THINKING_BUDGET,
    parsed.data.OPENAI_API_KEY,
    parsed.data.GOOGLE_API_KEY,
  );

  const embeddingModel = parsed.data.EMBEDDING_MODEL ?? parsed.data.CHATBOT_EMBEDDING_MODEL;
  const embeddingProvider = parsed.data.CHATBOT_EMBEDDING_MODEL && !parsed.data.EMBEDDING_MODEL
    ? "openai"
    : parsed.data.EMBEDDING_PROVIDER;
  if (embeddingModel && embeddingProvider === "openai" && !parsed.data.OPENAI_API_KEY) {
    throw new Error(
      "Invalid application configuration: OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai and EMBEDDING_MODEL is set",
    );
  }
  if (embeddingModel && embeddingProvider === "gemini" && !parsed.data.GOOGLE_API_KEY) {
    throw new Error(
      "Invalid application configuration: GOOGLE_API_KEY is required when EMBEDDING_PROVIDER=gemini and EMBEDDING_MODEL is set",
    );
  }
  validateProviderConfig(
    "UTILITY",
    parsed.data.UTILITY_MODEL,
    parsed.data.UTILITY_PROVIDER,
    parsed.data.UTILITY_MODE,
    parsed.data.UTILITY_GEMINI_THINKING_BUDGET,
    parsed.data.OPENAI_API_KEY,
    parsed.data.GOOGLE_API_KEY,
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
    },
    lavalink: {
      host: parsed.data.LAVALINK_HOST,
      port: parsed.data.LAVALINK_PORT,
      password: parsed.data.LAVALINK_PASSWORD,
      secure: parsed.data.LAVALINK_SECURE,
    },
    chat: buildChatConfiguration(parsed.data),
    utilityChat: buildUtilityChatConfiguration(parsed.data),
    embeddings: embeddingModel
      ? embeddingProvider === "gemini"
        ? { provider: "gemini", apiKey: parsed.data.GOOGLE_API_KEY as string, model: embeddingModel }
        : {
            provider: "openai",
            apiKey: parsed.data.OPENAI_API_KEY as string,
            baseUrl: parsed.data.OPENAI_BASE_URL.replace(/\/$/, ""),
            model: embeddingModel,
          }
      : null,
  };
}

// A task (CHATBOT_*/UTILITY_*) is "enabled" only when its MODEL is set — the
// vendor credential is resolved separately from the shared OPENAI_API_KEY/
// GOOGLE_API_KEY pool, so it's never itself the enable/disable switch. Fields
// that only apply to the *other* provider (CHATBOT_MODE for gemini,
// CHATBOT_GEMINI_THINKING_BUDGET for openai) are rejected outright rather
// than silently ignored, so a mismatched config fails at startup instead of
// quietly doing something other than what was configured.
function validateProviderConfig(
  namespace: "CHATBOT" | "UTILITY",
  model: string | undefined,
  provider: "openai" | "gemini",
  mode: "chat_completions" | "responses" | undefined,
  geminiThinkingBudget: number | undefined,
  openaiApiKey: string | undefined,
  googleApiKey: string | undefined,
): void {
  if (provider === "gemini" && mode !== undefined) {
    throw new Error(
      `Invalid application configuration: ${namespace}_MODE is not applicable when ${namespace}_PROVIDER=gemini`,
    );
  }
  if (provider === "openai" && geminiThinkingBudget !== undefined) {
    throw new Error(
      `Invalid application configuration: ${namespace}_GEMINI_THINKING_BUDGET is only applicable when ${namespace}_PROVIDER=gemini`,
    );
  }
  if (!model) return;
  if (provider === "gemini" && !googleApiKey) {
    throw new Error(
      `Invalid application configuration: GOOGLE_API_KEY is required when ${namespace}_PROVIDER=gemini and ${namespace}_MODEL is set`,
    );
  }
  if (provider === "openai" && !openaiApiKey) {
    throw new Error(
      `Invalid application configuration: OPENAI_API_KEY is required when ${namespace}_PROVIDER=openai and ${namespace}_MODEL is set`,
    );
  }
}

function buildChatConfiguration(
  data: z.infer<typeof environmentSchema>,
): ApplicationConfiguration["chat"] {
  if (!data.CHATBOT_MODEL) return null;
  const models = [data.CHATBOT_MODEL, ...data.CHATBOT_FALLBACK_MODELS];
  // Falls back to the primary chain when unset, so leaving
  // CHATBOT_SUMMARY_MODEL unconfigured is byte-for-byte today's behavior.
  const summaryModels = data.CHATBOT_SUMMARY_MODEL
    ? [data.CHATBOT_SUMMARY_MODEL, ...data.CHATBOT_SUMMARY_FALLBACK_MODELS]
    : models;
  const maxOutputTokens = data.CHATBOT_MAX_OUTPUT_TOKENS;
  const summaryMaxOutputTokens = data.CHATBOT_SUMMARY_MAX_OUTPUT_TOKENS;

  if (data.CHATBOT_PROVIDER === "gemini") {
    return {
      provider: "gemini",
      // validateProviderConfig already guarantees this is set.
      apiKey: data.GOOGLE_API_KEY as string,
      models,
      summaryModels,
      summaryMaxOutputTokens,
      maxOutputTokens,
      thinkingBudget: data.CHATBOT_GEMINI_THINKING_BUDGET ?? null,
    };
  }
  const apiKey = data.OPENAI_API_KEY as string;
  const baseUrl = data.OPENAI_BASE_URL.replace(/\/$/, "");
  if ((data.CHATBOT_MODE ?? "chat_completions") === "responses") {
    return {
      provider: "openai-responses",
      apiKey,
      baseUrl,
      models,
      summaryModels,
      summaryMaxOutputTokens,
      summaryReasoningEffort: data.CHATBOT_SUMMARY_REASONING_EFFORT,
      reasoningEffort: data.CHATBOT_REASONING_EFFORT,
      verbosity: data.CHATBOT_VERBOSITY,
      maxOutputTokens,
    };
  }
  return {
    provider: "openai-compatible",
    apiKey,
    baseUrl,
    models,
    summaryModels,
    summaryMaxOutputTokens,
    maxOutputTokens,
  };
}

// Mirrors buildChatConfiguration's shape/branching but for the fully
// independent UTILITY_* task — no summaryModels/embedding configuration here, since
// this config block IS the summary/utility model; it doesn't need further
// sub-routing, and embeddings stay tied to the main chatbot config.
function buildUtilityChatConfiguration(
  data: z.infer<typeof environmentSchema>,
): ApplicationConfiguration["utilityChat"] {
  if (!data.UTILITY_MODEL) return null;
  const models = [data.UTILITY_MODEL, ...data.UTILITY_FALLBACK_MODELS];
  const maxOutputTokens = data.UTILITY_MAX_OUTPUT_TOKENS;

  if (data.UTILITY_PROVIDER === "gemini") {
    return {
      provider: "gemini",
      apiKey: data.GOOGLE_API_KEY as string,
      models,
      maxOutputTokens,
      thinkingBudget: data.UTILITY_GEMINI_THINKING_BUDGET ?? null,
    };
  }
  const apiKey = data.OPENAI_API_KEY as string;
  const baseUrl = data.OPENAI_BASE_URL.replace(/\/$/, "");
  if ((data.UTILITY_MODE ?? "chat_completions") === "responses") {
    return {
      provider: "openai-responses",
      apiKey,
      baseUrl,
      models,
      reasoningEffort: data.UTILITY_REASONING_EFFORT,
      verbosity: data.UTILITY_VERBOSITY,
      maxOutputTokens,
    };
  }
  return {
    provider: "openai-compatible",
    apiKey,
    baseUrl,
    models,
    maxOutputTokens,
  };
}
