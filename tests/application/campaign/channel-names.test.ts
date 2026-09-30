import { describe, expect, it } from "vitest";

import { resourceMarker } from "../../../src/application/campaign/setup/channel-names.js";

describe("channel names", () => {
  it("builds a stable marker", () => {
    expect(resourceMarker("abc", "party")).toBe("dnd:abc:party");
  });
});
