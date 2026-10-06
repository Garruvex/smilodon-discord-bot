import { describe, expect, it } from "vitest";

import { resolveD20Test, rollD20Test, rollMatchesSpec } from "../../../src/domain/campaign/dice/d20-test.js";
import { dice } from "../../../src/domain/campaign/dice/dice-expression.js";
import { classifyRollMoments, type MomentInput } from "../../../src/domain/campaign/dice/roll-moments.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { d20Roll } from "./campaign-fixtures.js";

function classify(input: Partial<MomentInput> & Pick<MomentInput, "roll">): ReturnType<typeof classifyRollMoments> {
  return classifyRollMoments({ kind: "abilityCheck", target: 15, naturalRule: "no-effect", ...input });
}

describe("resolveD20Test", () => {
  it("makes a natural 20 attack a critical hit and a natural 1 a miss regardless of the total", () => {
    expect(resolveD20Test("attack", 20, 22, 30, "no-effect")).toEqual({ success: true, decidedByNatural: "natural20", critical: true });
    expect(resolveD20Test("attack", 1, 25, 10, "no-effect")).toMatchObject({ success: false, decidedByNatural: "natural1" });
  });

  it("gives natural rolls on checks no effect under the 2014 rules, and automatic results under the house rule", () => {
    expect(resolveD20Test("abilityCheck", 20, 25, 30, "no-effect")).toMatchObject({ success: false, decidedByNatural: null });
    expect(resolveD20Test("abilityCheck", 20, 25, 30, "automatic")).toMatchObject({ success: true, decidedByNatural: "natural20" });
    expect(resolveD20Test("savingThrow", 1, 12, 10, "automatic")).toMatchObject({ success: false, decidedByNatural: "natural1" });
  });
});

describe("rollD20Test and rollMatchesSpec", () => {
  it("adds bonus dice to the total and matches the spec it was rolled from", () => {
    const spec = { mode: "advantage" as const, modifier: 3, bonusDice: [{ source: "spell:bless", die: dice(1, 4) }] };
    const roll = rollD20Test(spec, new SeededRandomSource(9));
    expect(roll.total).toBe(roll.d20.total + (roll.bonusDice[0]?.roll.total ?? 0));
    expect(rollMatchesSpec(roll, spec)).toBe(true);
    expect(rollMatchesSpec(roll, { ...spec, modifier: 4 })).toBe(false);
    expect(rollMatchesSpec(roll, { ...spec, bonusDice: [] })).toBe(false);
  });

  it("rejects a roll whose natural die is not the one its mode keeps", () => {
    const roll = d20Roll("advantage", [4, 15], 2);
    expect(rollMatchesSpec({ ...roll, d20: { ...roll.d20, natural: 4, total: 6 }, total: 6 }, { mode: "advantage", modifier: 2, bonusDice: [] })).toBe(false);
  });
});

describe("classifyRollMoments", () => {
  it("headlines a natural 20 attack as a critical hit and a natural 1 as an automatic miss", () => {
    expect(classify({ kind: "attack", roll: d20Roll("normal", [20], 5) }).headline).toEqual({ kind: "criticalHit" });
    expect(classify({ kind: "attack", roll: d20Roll("normal", [1], 5) }).headline).toEqual({ kind: "automaticMiss" });
  });

  it("headlines death save naturals", () => {
    expect(classify({ kind: "deathSave", target: 10, roll: d20Roll("normal", [20], 0) }).headline).toEqual({ kind: "deathSaveRevival" });
    expect(classify({ kind: "deathSave", target: 10, roll: d20Roll("normal", [1], 0) }).headline).toEqual({ kind: "deathSaveDoubleFailure" });
  });

  it("gives a natural 20 check the flourish even when the total still fails", () => {
    const moments = classify({ target: 30, roll: d20Roll("normal", [20], 5) });
    expect(moments.headline).toEqual({ kind: "natural20" });
  });

  it("tags meeting the DC exactly and missing it by one", () => {
    expect(classify({ roll: d20Roll("normal", [12], 3) }).headline).toEqual({ kind: "exactlyEnough" });
    expect(classify({ roll: d20Roll("normal", [11], 3) }).headline).toEqual({ kind: "missedByOne" });
    expect(classify({ roll: d20Roll("normal", [13], 3) })).toEqual({ headline: null, tags: [] });
  });

  it("names the bonus die that turned a failure into a success", () => {
    const moments = classify({ kind: "attack", roll: d20Roll("normal", [10], 3, [{ source: "spell:bless", value: 3 }]) });
    expect(moments.headline).toEqual({ kind: "bonusDieFlipped", sources: ["spell:bless"] });
  });

  it("does not credit a bonus die that did not change the outcome", () => {
    const moments = classify({ roll: d20Roll("normal", [18], 3, [{ source: "spell:bless", value: 2 }]) });
    expect(moments).toEqual({ headline: null, tags: [] });
  });

  it("tags advantage that saved the roll and disadvantage that cost it", () => {
    expect(classify({ roll: d20Roll("advantage", [4, 16], 2) }).headline).toEqual({ kind: "advantageSaved" });
    expect(classify({ roll: d20Roll("disadvantage", [4, 16], 2) }).headline).toEqual({ kind: "disadvantageCost" });
    expect(classify({ roll: d20Roll("advantage", [14, 16], 2) })).toEqual({ headline: null, tags: [] });
  });

  it("keeps the highest tier as the headline and the rest as tags", () => {
    const moments = classify({ kind: "attack", target: 25, roll: d20Roll("advantage", [3, 20], 4) });
    expect(moments.headline).toEqual({ kind: "criticalHit" });
    expect(moments.tags).toEqual([{ kind: "advantageSaved" }]);
  });

  it("does not tag near misses that the natural roll decided", () => {
    const moments = classify({ kind: "attack", target: 6, roll: d20Roll("normal", [1], 4) });
    expect(moments).toEqual({ headline: { kind: "automaticMiss" }, tags: [] });
  });
});
