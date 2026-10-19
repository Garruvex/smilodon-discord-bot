import pino, { type Logger } from "pino";
import { randomUUID } from "node:crypto";

import type { ApplicationConfiguration } from "../../config/configuration.js";
import { diagnosticFields } from "../../application/diagnostics/chat-diagnostics.js";

const processRunId = randomUUID();

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
    mixin: () => ({ ...diagnosticFields() }),
    base: {
      application: "fntu-discord-bot",
      environment: configuration.environment,
      instanceName: configuration.instanceName ?? "default",
      processRunId,
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
