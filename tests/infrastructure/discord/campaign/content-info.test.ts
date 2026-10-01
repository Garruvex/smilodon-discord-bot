import { describe, expect, it } from "vitest";

import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { texts } from "../../../../src/application/i18n/texts.js";
import { describeContent } from "../../../../src/infrastructure/discord/campaign/content-info.js";
import { inspectMenu, inspectText } from "../../../../src/infrastructure/discord/campaign/info-menu.js";
import { elspeth, mira, ruleset } from "../../../domain/campaign/campaign-fixtures.js";

const content = ruleset().content;
const english = { text: texts.en, nameOf: (id: string): string => enSrd51Glossary.names[id] ?? id, level: 1 };

function describe1(id: string, context = english): string {
  const definition = content.find(id);
  if (definition === undefined) throw new Error(`No content ${id}`);
  return describeContent(definition, context) ?? "";
}

describe("the spell, item and feature stats screen", () => {
  it("reads a spell's school, casting, range and damage from its definition", () => {
    const text = describe1("spell:fire-bolt");
    expect(text).toContain("cantrip");
    expect(text).toContain("Spell attack roll");
    expect(text).toMatch(/1d10 fire damage/);
  });

  it("shows healing for a spell that needs no roll", () => {
    const text = describe1("spell:cure-wounds");
    expect(text).toContain("No roll needed");
    expect(text).toContain("heals");
  });

  it("shows a weapon's damage and range, and armor's armor class", () => {
    expect(describe1("item:longsword")).toMatch(/1d8 slashing damage · melee/);
    expect(describe1("item:chain-mail")).toContain("Heavy armor · AC 16");
    expect(describe1("item:shield")).toContain("+2 AC");
  });

  it("says how a feature is used and when it comes back", () => {
    const text = describe1("feature:second-wind");
    expect(text).toContain("bonus action");
    expect(text).toContain("short rest");
  });

  it("speaks Traditional Chinese", () => {
    const text = describe1("spell:fire-bolt", { text: texts["zh-TW"], nameOf: (id) => zhTwSrd51Glossary.names[id] ?? id, level: 1 });
    expect(text).toContain("戲法");
    expect(text).toContain("火焰傷害");
  });

  it("offers only what the hero has, and refuses an id the hero does not hold", () => {
    const menu = inspectMenu(elspeth, enSrd51Glossary, texts.en, "c1");
    expect(menu).not.toBeNull();
    expect(inspectText(mira, "spell:fire-bolt", content, enSrd51Glossary, texts.en)).toBe(texts.en.campaign.info.gone);
  });

  it("describes every spell, item and feature in the ruleset without failing", () => {
    for (const kind of ["spell", "item", "feature"] as const) {
      for (const definition of content.all(kind)) {
        expect(() => describeContent(definition, english)).not.toThrow();
      }
    }
  });
});
