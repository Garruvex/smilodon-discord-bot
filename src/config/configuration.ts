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
// (chat/utilityChat) it belongs to.
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

type ChatConfigVariant = ChatProviderVariant & {
  summaryModels: readonly string[];
  summaryMaxOutputTokens: number;
  summaryReasoningEffort?: "minimal" | "low" | "medium" | "high";
};

export type EmbeddingConfiguration =
  | { provider: "openai"; apiKey: string; baseUrl: string; model: string }
  | { provider: "gemini"; apiKey: string; model: string };

// Tunables for DefaultMemoryEngine (see MemoryEngineLimits in
// memory-engine.ts, which documents what each value actually controls and
// why the conflict threshold's default is only a starting estimate).
export interface MemoryConfiguration {
  maxSelectedChars: number;
  maxStatementChars: number;
  maxSlotChars: number;
  maxTopicChars: number;
  conflictSimilarityThreshold: number;
  maxRelationHops: number;
  relationHopBoostBase: number;
}

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
  // embedding configuration here — this block IS the summary/utility model already.
  utilityChat: ChatProviderVariant | null;
  // Independent of chat/utility generation: either vendor can provide
  // vectors regardless of which provider produces replies or summaries.
  embeddings: EmbeddingConfiguration | null;
  memory: MemoryConfiguration;
  // Bounds for delivering a chat reply back to Discord — independent of
  // which chat provider produced it. See chat-message-chunker.ts and
  // chat-image-delivery.ts.
  chatDelivery: {
    maxGeneratedImageAggregateBytes: number;
  };
}
