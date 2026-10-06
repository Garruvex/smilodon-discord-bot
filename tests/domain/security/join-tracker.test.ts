import { describe, expect, it } from "vitest";

import { JoinTracker, accountAgeDays } from "../../../src/domain/security/join-tracker.js";

const join = (userId: string, at: number, accountCreatedAt = 0): { userId: string; at: number; accountCreatedAt: number } =>
  ({ userId, at, accountCreatedAt });

describe("JoinTracker", () => {
  it("stays calm below the threshold", () => {
    const tracker = new JoinTracker();
    expect(tracker.record("g", join("1", 1_000), 30_000, 3).raid).toBe(false);
    expect(tracker.record("g", join("2", 2_000), 30_000, 3).raid).toBe(false);
  });

  it("starts a raid at the threshold and names everyone in the burst", () => {
    const tracker = new JoinTracker();
    tracker.record("g", join("1", 1_000), 30_000, 3);
    tracker.record("g", join("2", 2_000), 30_000, 3);
    const verdict = tracker.record("g", join("3", 3_000), 30_000, 3);
    expect(verdict).toMatchObject({ raid: true, started: true });
    expect(verdict.affected.map((entry) => entry.userId)).toEqual(["1", "2", "3"]);
  });

  it("treats later joiners as part of the same raid, one at a time", () => {
    const tracker = new JoinTracker();
    for (const id of ["1", "2", "3"]) tracker.record("g", join(id, 1_000), 30_000, 3);
    const later = tracker.record("g", join("4", 10_000), 30_000, 3);
    expect(later).toMatchObject({ raid: true, started: false });
    expect(later.affected.map((entry) => entry.userId)).toEqual(["4"]);
  });

  it("ends once joins stop for a whole window", () => {
    const tracker = new JoinTracker();
    for (const id of ["1", "2", "3"]) tracker.record("g", join(id, 1_000), 30_000, 3);
    expect(tracker.record("g", join("4", 100_000), 30_000, 3).raid).toBe(false);
  });

  it("doesn't count joins that are too far apart", () => {
    const tracker = new JoinTracker();
    tracker.record("g", join("1", 0), 30_000, 3);
    tracker.record("g", join("2", 40_000), 30_000, 3);
    expect(tracker.record("g", join("3", 80_000), 30_000, 3).raid).toBe(false);
  });

  it("keeps guilds apart", () => {
    const tracker = new JoinTracker();
    tracker.record("g1", join("1", 1_000), 30_000, 3);
    tracker.record("g2", join("2", 1_000), 30_000, 3);
    expect(tracker.record("g1", join("3", 1_000), 30_000, 3).raid).toBe(false);
  });
});

describe("accountAgeDays", () => {
  it("says how old the account was when it joined", () => {
    expect(accountAgeDays(join("1", 3 * 86_400_000, 0))).toBe(3);
  });
});
