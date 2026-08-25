import { describe, expect, it } from "vitest";

import { parseDurationMs } from "../../src/domain/time/duration.js";

describe("parseDurationMs", () => {
  it("parses individual units", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(5 * 60_000);
    expect(parseDurationMs("2h")).toBe(2 * 3_600_000);
    expect(parseDurationMs("1d")).toBe(24 * 3_600_000);
  });

  it("parses combined units", () => {
    expect(parseDurationMs("1d12h")).toBe(24 * 3_600_000 + 12 * 3_600_000);
    expect(parseDurationMs("1h30m")).toBe(3_600_000 + 30 * 60_000);
    expect(parseDurationMs("2h 15m")).toBe(2 * 3_600_000 + 15 * 60_000);
  });

  it("rejects empty or unparseable input", () => {
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("soon")).toBeNull();
    expect(parseDurationMs("tomorrow")).toBeNull();
  });
});
