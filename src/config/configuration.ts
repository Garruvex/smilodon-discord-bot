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
  chat: {
    apiKey: string;
    baseUrl: string;
    model: string;
    mode: "chat_completions" | "responses";
    reasoningEffort: "minimal" | "low" | "medium" | "high";
    verbosity: "low" | "medium" | "high";
    maxOutputTokens: number;
  } | null;
}
