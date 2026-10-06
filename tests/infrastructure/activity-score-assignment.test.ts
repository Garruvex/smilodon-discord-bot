import { describe, expect, it } from "vitest";
// @ts-expect-error Browser modules are authored in JavaScript.
import { assignScore, availableScores, standardScores } from "../../src/activity/score-assignment.js";

describe("character sheet score assignment", () => {
  it("eliminates assigned scores and rejects duplicate assignments", () => {
    const assigned = assignScore({ str: null, dex: null }, "str", 14);
    expect(availableScores(assigned, "dex")).not.toContain(14);
    expect(availableScores(assigned, "str")).toContain(14);
    expect(assignScore(assigned, "dex", 14)).toEqual(assigned);
  });

  it("returns a cleared or replaced score to the available pool", () => {
    const assigned = { str: 14, dex: 15 };
    expect(availableScores(assignScore(assigned, "str", null), "dex")).toContain(14);
    expect(availableScores(assignScore(assigned, "str", 13), "dex")).toContain(14);
    expect(assignScore(assigned, "str", 20)).toEqual(assigned);
  });

  it("leaves no reusable scores after the standard array is fully assigned", () => {
    const assigned = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map((ability, index) => [ability, standardScores[index]]));
    expect(availableScores(assigned, "str")).toEqual([15]);
    expect(assignScore(assigned, "str", 14)).toEqual(assigned);
  });
});
