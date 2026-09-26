import { describe, expect, it } from "vitest";

import {
  abilityModifier,
  checkModifier,
  savingThrowModifier,
  skills,
} from "../../../src/domain/campaign/character/character-sheet.js";
import { HouseRuleError, naturalRollsOnChecks, resolveHouseRules } from "../../../src/domain/campaign/rules/house-rules.js";
import { borin, mira } from "./campaign-fixtures.js";

describe("character modifiers", () => {
  it("derives ability modifiers from scores", () => {
    expect([1, 8, 9, 10, 11, 16, 20].map(abilityModifier)).toEqual([-5, -1, -1, 0, 0, 3, 5]);
  });

  it("adds proficiency to proficient skills and double proficiency with expertise", () => {
    expect(checkModifier(mira, { kind: "skill", skill: "stealth" })).toBe(7);
    expect(checkModifier(mira, { kind: "skill", skill: "perception" })).toBe(2);
    expect(checkModifier(mira, { kind: "skill", skill: "athletics" })).toBe(-1);
    expect(checkModifier(borin, { kind: "ability", ability: "str" })).toBe(3);
  });

  it("adds proficiency only to proficient saving throws", () => {
    expect(savingThrowModifier(borin, "con")).toBe(4);
    expect(savingThrowModifier(borin, "wis")).toBe(1);
  });

  it("lists the eighteen SRD skills", () => {
    expect(skills).toHaveLength(18);
  });
});

describe("resolveHouseRules", () => {
  it("defaults unset options and returns saved values", () => {
    expect(resolveHouseRules({}).option(naturalRollsOnChecks)).toBe("no-effect");
    expect(resolveHouseRules({ "natural-rolls-on-checks": "automatic" }).option(naturalRollsOnChecks)).toBe("automatic");
  });

  it("rejects unknown options and values, reporting all of them", () => {
    try {
      resolveHouseRules({ "natural-rolls-on-checks": "sometimes", flanking: "on" });
      expect.fail("Expected invalid house rules to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(HouseRuleError);
      expect((error as HouseRuleError).problems).toEqual([
        'Option "natural-rolls-on-checks" does not allow "sometimes".',
        'Unknown house-rule option "flanking".',
      ]);
    }
  });
});
