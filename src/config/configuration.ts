export interface DiscordConfiguration {
  token: string;
  applicationId: string;
}

export interface LavalinkConfiguration {
  host: string;
  port: number;
  password: string;
  secure: boolean;
}

// The knobs every provider variant carries regardless of which block
// (chat/utilityChat) it belongs to. `chat` adds summaryModels/embeddingModel
// on top (see ApplicationConfiguration.chat); `utilityChat` uses this as-is.
type ChatProviderVariant =
  | {
      provider: "openai-responses";
      apiKey: string;
      baseUrl: string;
      // Ordered (primary, ...fallback) model list — see ModelFallbackChain.
      // Always has at least one entry.
      models: readonly string[];
      reasoningEffort: "minimal" | "low" | "medium" | "high";
      verbosity: "low" | "medium" | "high";
      maxOutputTokens: number;
    }
  | {
      provider: "openai-compatible";
      apiKey: string;
      baseUrl: string;
      models: readonly string[];
      maxOutputTokens: number;
    }
  | {
      provider: "gemini";
      apiKey: string;
      models: readonly string[];
      maxOutputTokens: number;
      // null = leave Gemini's model-dependent default in place.
      thinkingBudget: number | null;
    };

type ChatConfigVariant =
  | (Extract<ChatProviderVariant, { provider: "openai-responses" }> & { summaryModels: readonly string[]; embeddingModel: string | null })
  | (Extract<ChatProviderVariant, { provider: "openai-compatible" }> & { summaryModels: readonly string[]; embeddingModel: string | null })
  | (Extract<ChatProviderVariant, { provider: "gemini" }> & { summaryModels: readonly string[]; embeddingModel: string | null });

export interface ApplicationConfiguration {
  instanceName?: string | null;
  environment: "development" | "test" | "production";
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  discord: DiscordConfiguration;
  ownerUserIds: ReadonlySet<string>;
  guildConfigurationDirectory: string;
  runtimeDataDirectory: string;
  persistence: {
    driver: "file" | "postgres";
    databaseUrl: string | null;
  };
  lavalink: LavalinkConfiguration;
  // The main chatbot persona/reply model (CHATBOT_* env vars). Keyed by
  // provider so each variant only carries the knobs that provider actually
  // reads — reasoningEffort/verbosity are OpenAI Responses-API concepts,
  // thinkingBudget is Gemini's; cramming all three into one flat shape means
  // every provider silently ignores fields meant for another.
  // Model chain for the two standalone structured-output calls that aren't
  // a chat reply (analyzeUserCustomization, summarizeDroppedExchanges) —
  // summaryModels defaults to `models` when CHATBOT_SUMMARY_MODEL is unset,
  // so it's always populated, never null. Superseded entirely by
  // `utilityChat` below when that's configured.
  chat: ChatConfigVariant | null;
  // Fully independent provider (UTILITY_* env vars) for the two standalone
  // structured-output calls — own credentials, own model, can be an
  // entirely different provider type from `chat`. Null means those calls
  // fall back to `chat`'s own summaryModels routing instead (see
  // dependencies.ts's `utilityProvider` fallback chain). No summaryModels/
  // embeddingModel here — this block IS the summary/utility model already.
  utilityChat: ChatProviderVariant | null;
}
