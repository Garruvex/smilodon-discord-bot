import { describe, expect, it } from "vitest";

import { buildHouseRulesView } from "../../../src/application/campaign/views/house-rules-view.js";
import { texts } from "../../../src/application/i18n/texts.js";
import { houseRuleOptions, houseRulePresets } from "../../../src/domain/campaign/rules/house-rules.js";

describe("the house rules view", () => {
  it("lists every option with its words, the value in force, and the values on offer", () => {
    const view = buildHouseRulesView(texts.en, { "healing-potion-cost": "bonus-action" }, true);
    expect(view.editable).toBe(true);
    expect(view.options.map((option) => option.id)).toEqual(houseRuleOptions.map((option) => option.id));
    expect(view.presets.map((preset) => preset.id)).toEqual(houseRulePresets.map((preset) => preset.id));
    const potion = view.options.find((option) => option.id === "healing-potion-cost")!;
    expect(potion.value).toBe("bonus-action");
    expect(potion.name).not.toBe("healing-potion-cost");
    expect(potion.values.map((value) => value.id)).toContain("action");
    expect(potion.values.every((value) => value.label !== "")).toBe(true);
  });

  it("falls back to each option's default and says in Chinese what the English says", () => {
    const english = buildHouseRulesView(texts.en, {}, false);
    const chinese = buildHouseRulesView(texts["zh-TW"], {}, false);
    expect(english.options.map((option) => option.value)).toEqual(houseRuleOptions.map((option) => option.defaultValue));
    expect(chinese.options[0]!.name).not.toBe(english.options[0]!.name);
  });
});
