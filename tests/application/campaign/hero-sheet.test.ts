import { describe, expect, it } from "vitest";

import { buildHeroSheetView, buildLevelUpView } from "../../../src/application/campaign/views/hero-sheet.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { borin, mira } from "../../domain/campaign/campaign-fixtures.js";
import { describedFeatures, featureText } from "../../../src/activity/feature-texts.js";

describe("the hero sheet", () => {
  it("reads scores, saves and skills as the engine rolls them", () => {
    const sheet = buildHeroSheetView(mira, undefined, false, enSrd51Glossary);
    expect(sheet.abilities.find((entry) => entry.ability === "dex")).toEqual({ ability: "dex", score: 16, modifier: 3 });
    expect(sheet.saves.filter((save) => save.proficient).map((save) => save.ability)).toEqual(["dex", "int"]);
    expect(sheet.skills.find((entry) => entry.skill === "stealth")).toMatchObject({ bonus: 7, proficiency: "expertise" });
    expect(sheet.skills.find((entry) => entry.skill === "athletics")).toMatchObject({ bonus: -1, proficiency: "none" });
    expect(sheet.passivePerception).toBe(12);
    expect(sheet.progress).toEqual({ level: 1, xp: 0, floor: 0, next: 300 });
    expect(sheet.hitDice).toMatchObject({ left: 1, max: 1 });
    expect(sheet.features.map((feature) => feature.name)).toEqual(["Sneak Attack", "Thieves' Cant"]);
  });

  it("shows no XP in a milestone game", () => {
    expect(buildHeroSheetView(mira, undefined, true, enSrd51Glossary).progress).toMatchObject({ xp: null, next: null });
  });
});

describe("the level-up view", () => {
  it("owes nothing until an improvement is waiting", () => {
    expect(buildLevelUpView(borin, enSrd51Glossary).owed).toBe(false);
    expect(buildLevelUpView({ ...borin, pendingAsi: 1 }, enSrd51Glossary)).toMatchObject({ owed: true, pendingAsi: 1 });
  });

  it("lists every class with the ones the hero does not qualify for greyed out", () => {
    const plan = buildLevelUpView({ ...mira, className: "rogue" }, enSrd51Glossary).classPlan;
    expect(plan?.landing).toBe("rogue");
    const choices = plan?.choices ?? [];
    expect(choices.find((choice) => choice.buildClass === "rogue")).toMatchObject({ current: true, allowed: true });
    expect(choices.find((choice) => choice.buildClass === "barbarian")).toMatchObject({ allowed: false });
    expect(choices.find((choice) => choice.buildClass === "barbarian")?.requires.length).toBeGreaterThan(0);
  });
});

describe("feature descriptions", () => {
  it("cover every feature the game names, in both languages", () => {
    const named = Object.keys(enSrd51Glossary.names).filter((id) => id.startsWith("feature:"));
    expect(named.filter((id) => !describedFeatures.includes(id.replace("feature:", "")))).toEqual([]);
    expect(zhTwSrd51Glossary.names["feature:rage"]).toBeDefined();
    for (const id of describedFeatures) {
      expect(featureText(id, "en")?.length).toBeGreaterThan(5);
      expect(featureText(id, "zh-TW")?.length).toBeGreaterThan(3);
    }
  });
});
