import pino, { type Logger } from "pino";
import { z } from "zod";
import { diagnosticFields } from "../../src/application/diagnostics/chat-diagnostics.js";

export function captureDiagnosticLogger(): { logger: Logger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const logger = pino({ mixin: () => ({ ...diagnosticFields() }) }, {
    write(line: string): void { records.push(z.record(z.unknown()).parse(JSON.parse(line))); },
  });
  return { logger, records };
}
