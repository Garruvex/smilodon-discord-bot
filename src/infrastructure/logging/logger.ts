import pino, { type Logger } from "pino";

import type { ApplicationConfiguration } from "../../config/configuration.js";

export function createLogger(configuration: ApplicationConfiguration): Logger {
  return pino({
    level: configuration.logLevel,
    base: {
      application: "fntu-discord-bot",
      environment: configuration.environment,
    },
    redact: {
      paths: ["token", "apiKey", "authorization", "req.headers.authorization"],
      censor: "[REDACTED]",
    },
    serializers: {
      error: pino.stdSerializers.err,
    },
  });
}
