import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateAdventure } from "../../../src/application/campaign/adventures/adventure-validator.js";
import { bundledAdventureIds, loadBundledAdventure } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";

const { content } = ruleset();
const languages = ["en", "zh-TW"] as const;
const sourceOf = (id: string, language: (typeof languages)[number]): string =>
  readFileSync(new URL(`../../../assets/campaign/adventures/${id}/${language}.yaml`, import.meta.url), "utf8").replaceAll(String.fromCharCode(13, 10), String.fromCharCode(10));

describe("bundled adventures", () => {
  it.each(bundledAdventureIds)("%s loads in both languages and passes every check, fight rehearsals included", (id) => {
    const editions = loadBundledAdventure(id);
    for (const language of languages) {
      const report = validateAdventure(sourceOf(id, language), content);
      expect(report.errors, `${id} ${language}`).toEqual([]);
      expect(report.rehearsals).toHaveLength(editions[language].bible.encounters.length * 3);
    }
  });

  it("the Ashfall Barrow is a full campaign: many scenes, fights and three level-ups", () => {
    const { bible } = loadBundledAdventure("ashfall-barrow").en;
    expect(bible.scenes.length).toBeGreaterThanOrEqual(6);
    expect(bible.encounters.length).toBeGreaterThanOrEqual(6);
    expect(bible.encounters.flatMap((encounter) => (encounter.milestoneLevel === undefined ? [] : [encounter.milestoneLevel]))).toEqual([2, 3, 4]);
  });
});
