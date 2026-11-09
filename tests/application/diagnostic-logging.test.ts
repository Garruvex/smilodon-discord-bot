import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/infrastructure/logging/logger.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";

describe("production diagnostic error serialization", () => {
  it("omits exception messages, bodies, stack traces, causes and arbitrary codes", () => {
    const lines: string[] = [];
    const logger = createLogger({ environment: "production", logLevel: "info" } as ApplicationConfiguration, { write: (line: string) => { lines.push(line); } });
    const error = Object.assign(new Error("SECRET_MESSAGE"), { status: 429, code: "SECRET_CODE", body: "SECRET_BODY", cause: new Error("SECRET_CAUSE") });
    logger.error({ error }, "Provider failed");
    logger.error({ err: error }, "Provider failed");
    logger.error(error, "Provider failed");
    expect(lines).toHaveLength(3);
    expect(lines.join(" ")).not.toMatch(/SECRET|stack|cause/u);
    expect(lines.every((line) => line.includes('"failure":"rate_limited"') && line.includes('"httpStatus":429'))).toBe(true);
  });
});
