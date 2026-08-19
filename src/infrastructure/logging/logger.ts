import pino, { type Logger } from "pino";

import type { ApplicationConfiguration } from "../../config/configuration.js";

export function createLogger(configuration: ApplicationConfiguration): Logger {
  const prettyTransport = configuration.environment === "production"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,application,environment" },
        },
      };
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
      err: pino.stdSerializers.err,
    },
    ...prettyTransport,
  });
}
