import { describe, expect, it } from "vitest";

import {
  formatRoleGroupList,
  roleGroupDescriptions,
} from "../../src/application/access/role-group-descriptions.js";

describe("role group descriptions", () => {
  it("documents music-controller access for setup and settings messaging", () => {
    expect(roleGroupDescriptions.musicController).toContain("/play");
    expect(roleGroupDescriptions.musicController).toContain("control channel");
  });

  it("formats empty and configured role lists", () => {
    expect(formatRoleGroupList(new Set())).toBe("none configured");
    expect(formatRoleGroupList(new Set(["123456789012345678"]))).toBe("<@&123456789012345678>");
  });
});
