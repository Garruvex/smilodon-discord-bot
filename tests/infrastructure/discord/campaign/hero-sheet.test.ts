import { describe, expect, it } from "vitest";

import { buildHeroView } from "../../../../src/application/campaign/views/campaign-views.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { texts } from "../../../../src/application/i18n/texts.js";
import { renderHeroSheet } from "../../../../src/infrastructure/discord/campaign/hero-sheet.js";
import { mira, newCampaign, ruleset } from "../../../domain/campaign/campaign-fixtures.js";

const content = ruleset().content;
const sheet = { ...mira, className: "Rogue" };

describe("the hero sheet", () => {
  it("lists vitals, abilities, skills with expertise, gear, and features in English", () => {
    const state = newCampaign();
    const view = buildHeroView({ ...state, characters: { ...state.characters, "c-mira": sheet } }, sheet, content);
    const text = renderHeroSheet(sheet, view, texts.en, enSrd51Glossary);
    expect(text).toContain("**Mira · Rogue · Level 1**");
    expect(text).toContain("HP 9/9 · AC 14 · Speed 30 ft");
    expect(text).toContain("STR 8 · DEX 16 · CON 12 · INT 13 · WIS 10 · CHA 14");
    expect(text).toContain("Skills: Perception, Stealth (expertise)");
    expect(text).toContain("Shortsword");
    expect(text).not.toContain("Spells:");
  });

  it("speaks Traditional Chinese with English ability abbreviations", () => {
    const view = buildHeroView(newCampaign(), sheet, content);
    const text = renderHeroSheet(sheet, view, texts["zh-TW"], zhTwSrd51Glossary);
    expect(text).toContain("Mira · Rogue · 1 級");
    expect(text).toContain("敏捷 DEX 16");
    expect(text).toContain("隱匿（專精）");
  });
});
