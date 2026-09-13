import { describe, expect, it } from "vitest";

import { computeTotalBoostedMs, formatDurationMs } from "../../src/application/members/boost-duration.js";
import type { BoostEvent } from "../../src/application/members/boost-history-store.js";

const day = 86_400_000;

describe("computeTotalBoostedMs", () => {
  it("sums completed start/end pairs from the log", () => {
    const events: BoostEvent[] = [
      { eventType: "started", occurredAt: new Date(0) },
      { eventType: "ended", occurredAt: new Date(5 * day) },
      { eventType: "started", occurredAt: new Date(10 * day) },
      { eventType: "ended", occurredAt: new Date(12 * day) },
    ];

    expect(computeTotalBoostedMs(events, null, new Date(20 * day))).toBe(7 * day);
  });

  it("adds the current ongoing streak from live premiumSince, not the log", () => {
    const events: BoostEvent[] = [
      { eventType: "started", occurredAt: new Date(0) },
      { eventType: "ended", occurredAt: new Date(5 * day) },
    ];
    const currentlyBoostingSince = new Date(10 * day);
    const now = new Date(13 * day);

    expect(computeTotalBoostedMs(events, currentlyBoostingSince, now)).toBe(5 * day + 3 * day);
  });

  it("handles a member currently boosting with no logged history at all", () => {
    const currentlyBoostingSince = new Date(0);
    const now = new Date(2 * day);

    expect(computeTotalBoostedMs([], currentlyBoostingSince, now)).toBe(2 * day);
  });

  it("returns zero for a member who has never boosted", () => {
    expect(computeTotalBoostedMs([], null, new Date())).toBe(0);
  });
});

describe("formatDurationMs", () => {
  it("formats sub-hour durations", () => {
    expect(formatDurationMs(30 * 60_000)).toBe("less than an hour");
  });

  it("formats days and hours", () => {
    expect(formatDurationMs(2 * day + 3 * 3_600_000)).toBe("2 days, 3 hours");
  });

  it("uses singular units", () => {
    expect(formatDurationMs(day + 3_600_000)).toBe("1 day, 1 hour");
  });
});
