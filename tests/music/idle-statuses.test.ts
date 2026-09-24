import { describe, expect, it } from "vitest";

import { idleStatuses, nextIdleStatus } from "../../src/application/music/idle-statuses.js";

describe("idle statuses", () => {
  it("fit in a Discord activity name and are all different", () => {
    for (const status of idleStatuses) {
      expect(status.name.trim()).not.toBe("");
      expect(status.name.length).toBeLessThanOrEqual(128);
    }
    expect(new Set(idleStatuses.map((status) => status.name)).size).toBe(idleStatuses.length);
  });

  it("never picks the status that is already showing", () => {
    for (const current of idleStatuses) {
      for (const roll of [0, 0.5, 0.999]) {
        expect(nextIdleStatus(current, () => roll)).not.toBe(current);
      }
    }
  });

  it("picks from the whole list when nothing is showing yet", () => {
    expect(nextIdleStatus(null, () => 0)).toBe(idleStatuses[0]);
    expect(nextIdleStatus(null, () => 0.999)).toBe(idleStatuses[idleStatuses.length - 1]);
  });
});
