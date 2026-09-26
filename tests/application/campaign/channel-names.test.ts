import { describe, expect, it } from "vitest";

import { gameChannelNames, resourceMarker, slugify } from "../../../src/application/campaign/setup/channel-names.js";

describe("channel names", () => {
  it("makes lowercase, hyphenated names and keeps letters from any script", () => {
    expect(slugify("Moonlit Ruins!")).toBe("moonlit-ruins");
    expect(slugify("  月光遺跡  ")).toBe("月光遺跡");
    expect(slugify("Ünï cödé — #1")).toBe("ünï-cödé-1");
    expect(slugify("!!!")).toBe("campaign");
  });

  it("stays within Discord's length limit, leaving room for the suffix", () => {
    const names = gameChannelNames("x".repeat(300), new Set());
    expect([...names.party].length).toBeLessThanOrEqual(100);
    expect(names.party.endsWith("-stats")).toBe(true);
  });

  it("names the adventure channel after the game and the party channel with -stats", () => {
    expect(gameChannelNames("Moonlit Ruins", new Set())).toEqual({ adventure: "moonlit-ruins", party: "moonlit-ruins-stats" });
  });

  it("adds a number to both names when either is taken", () => {
    expect(gameChannelNames("Moonlit Ruins", new Set(["moonlit-ruins"]))).toEqual({ adventure: "moonlit-ruins-2", party: "moonlit-ruins-2-stats" });
    expect(gameChannelNames("Moonlit Ruins", new Set(["moonlit-ruins-stats", "moonlit-ruins-2"]))).toEqual({ adventure: "moonlit-ruins-3", party: "moonlit-ruins-3-stats" });
  });

  it("builds a stable marker", () => {
    expect(resourceMarker("abc", "party")).toBe("dnd:abc:party");
  });
});
