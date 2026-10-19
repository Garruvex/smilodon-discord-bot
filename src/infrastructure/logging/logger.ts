import pino, { type Logger } from "pino";

import type { ApplicationConfiguration } from "../../config/configuration.js";
import { diagnosticFields, diagnosticProcessRunId, safeFailure } from "../../application/diagnostics/chat-diagnostics.js";
import { diagnosticBuildVersion } from "../../application/diagnostics/gateway-diagnostics.js";

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
      processRunId: diagnosticProcessRunId,
      buildVersion: diagnosticBuildVersion(),
    },
    redact: {
      paths: ["token", "apiKey", "authorization", "req.headers.authorization"],
      censor: "[REDACTED]",
    },
    serializers: {
      error: (error: unknown) => safeFailure(error, "operation_error"),
      err: (error: unknown) => safeFailure(error, "operation_error"),
    },
    ...prettyTransport,
  });
}
