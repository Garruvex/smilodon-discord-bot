import { describe, expect, it } from "vitest";

import type { HeroView, PanelView } from "../../../../src/application/campaign/views/campaign-views.js";
import { texts } from "../../../../src/application/i18n/texts.js";
import { renderAdventurePanel } from "../../../../src/infrastructure/discord/campaign/adventure-panel.js";
import { accents, cardLimits } from "../../../../src/infrastructure/discord/campaign/card-payload.js";
import { hpBar, renderHeroCard } from "../../../../src/infrastructure/discord/campaign/hero-card.js";
import { flatten } from "./card-helpers.js";

const collecting: PanelView = {
  campaignName: "Moonlit Ruins",
  sceneTitle: "Old Watchtower",
  mode: "collecting",
  roundNumber: 4,
  closesAt: 1_800_000_000_000,
  roster: [
    { characterId: "c-mira", userId: "1", heroName: "Mira", status: "submitted" },
    { characterId: "c-borin", userId: "2", heroName: "Borin", status: "thinking" },
    { characterId: "c-elin", userId: "3", heroName: "Elin", status: "away" },
  ],
  pendingRolls: [],
  combat: null,
};

const labels = (view: PanelView, language: "en" | "zh-TW" = "en"): string[] =>
  flatten(renderAdventurePanel(view, texts[language], "camp")).buttons.map((button) => button.label);

describe("the adventure panel", () => {
  it("shows the scene, round, deadline, and who has submitted", () => {
    const card = flatten(renderAdventurePanel(collecting, texts.en, "camp"));
    expect(card.accent).toBe(accents.green);
    expect(card.text).toContain("## Old Watchtower · Exploration · Round 4");
    expect(card.text).toContain("Submit an action or Pass. Closes <t:1800000000:R>.");
    expect(card.text).toContain("Mira ✓ Submitted · Borin … Thinking · Elin — Away");
    expect(card.buttons.map((button) => button.id)).toEqual(["dnd:act:camp", "dnd:pass:camp", "dnd:myHero:camp", "dnd:away:camp"]);
  });

  it("says so when there is no timer", () => {
    expect(flatten(renderAdventurePanel({ ...collecting, closesAt: null }, texts.en, "camp")).text).toContain("No timer.");
  });

  it("changes its controls with the state", () => {
    expect(labels({ ...collecting, mode: "planning" })).toEqual(["My Hero", "Away"]);
    expect(labels({ ...collecting, mode: "awaitingRolls", pendingRolls: [{ characterId: "c-mira", userId: "1", heroName: "Mira" }] })).toEqual(["Roll", "My Hero", "Away"]);
    expect(labels({ ...collecting, mode: "waiting" })).toEqual(["Continue", "I'm back", "My Hero"]);
    expect(labels({ ...collecting, mode: "paused" })).toEqual(["My Hero"]);
    expect(labels({ ...collecting, mode: "archived" })).toEqual([]);
  });

  it("explains a pause and a restart pause in words, on a gray card", () => {
    const paused = flatten(renderAdventurePanel({ ...collecting, mode: "paused" }, texts.en, "camp"));
    expect(paused.accent).toBe(accents.gray);
    expect(paused.text).toContain("Paused");
    expect(paused.text).toContain("The organizer paused the campaign.");
    expect(flatten(renderAdventurePanel({ ...collecting, mode: "recovery" }, texts.en, "camp")).text).toContain("The organizer must resume play.");
  });

  it("names who the rolls wait for, with Roll disabled when none", () => {
    const view: PanelView = { ...collecting, mode: "awaitingRolls", pendingRolls: [{ characterId: "c-mira", userId: "1", heroName: "Mira" }] };
    const card = flatten(renderAdventurePanel(view, texts.en, "camp"));
    expect(card.accent).toBe(accents.amber);
    expect(card.text).toContain("Waiting for rolls: Mira.");
    expect(card.buttons[0]?.disabled).toBe(false);
    expect(flatten(renderAdventurePanel({ ...view, pendingRolls: [] }, texts.en, "camp")).buttons[0]?.disabled).toBe(true);
  });

  it("summarizes a fight with hero HP and monster bands, never monster HP", () => {
    const view: PanelView = {
      ...collecting,
      mode: "combat",
      closesAt: null,
      combat: {
        round: 2,
        activeName: "Borin",
        party: [{ name: "Mira", hp: 4, maxHp: 9, condition: "active" }, { name: "Borin", hp: 12, maxHp: 12, condition: "active" }],
        foes: [{ name: "Goblin A", band: "bloodied" }, { name: "Wolf", band: "unhurt" }],
      },
    };
    const card = flatten(renderAdventurePanel(view, texts.en, "camp"));
    expect(card.accent).toBe(accents.red);
    expect(card.text).toContain("Combat, round 2. Active: Borin.");
    expect(card.text).toContain("Mira 4/9 · Borin 12/12");
    expect(card.text).toContain("Goblin A: bloodied · Wolf: unhurt");
  });

  it("speaks Traditional Chinese with short labels, and stays within Discord's limits", () => {
    const card = flatten(renderAdventurePanel(collecting, texts["zh-TW"], "camp"));
    expect(card.text).toContain("Old Watchtower · 探索 · 第 4 回合");
    expect(card.text).toContain("Mira ✓ 已提交 · Borin … 思考中 · Elin — 離開");
    expect(card.buttons.map((button) => button.label)).toEqual(["行動／修改", "跳過", "我的英雄", "離開"]);
    expect(card.componentCount).toBeLessThan(cardLimits.components);
    expect(card.text.length).toBeLessThan(cardLimits.characters);
  });
});

const hero: HeroView = {
  characterId: "c-mira",
  ownerUserId: "42",
  name: "Mira",
  className: "Rogue",
  level: 1,
  hp: 4,
  maxHp: 9,
  armorClass: 14,
  conditions: ["condition:prone"],
  presence: "present",
  down: false,
  fallen: false,
};

describe("hero cards", () => {
  it("show public identity, HP, defense, and conditions", () => {
    const card = flatten(renderHeroCard(hero, texts.en, "camp", () => "Prone"));
    expect(card.accent).toBe(accents.green);
    expect(card.text).toContain("**Mira** · Rogue · Lv 1");
    expect(card.text).toContain("Played by <@42>");
    expect(card.text).toContain("HP 4/9 · AC 14");
    expect(card.text).toContain("Prone · Present");
    expect(card.buttons).toEqual([{ id: "dnd:details:camp:c-mira", label: "Details", disabled: false }]);
  });

  it("marks away, downed, and fallen heroes in words and color", () => {
    expect(flatten(renderHeroCard({ ...hero, presence: "away", conditions: [] }, texts.en, "c", String)).text).toContain("No conditions · Away");
    const down = flatten(renderHeroCard({ ...hero, hp: 0, down: true }, texts.en, "c", String));
    expect(down.accent).toBe(accents.red);
    expect(down.text).toContain("Down");
    const fallen = flatten(renderHeroCard({ ...hero, hp: 0, down: true, fallen: true }, texts["zh-TW"], "c", String));
    expect(fallen.accent).toBe(accents.gray);
    expect(fallen.text).toContain("陣亡");
  });

  it("draws the HP bar in proportion, never overflowing", () => {
    expect(hpBar(9, 9)).toBe("▰▰▰▰▰▰▰▰");
    expect(hpBar(0, 9)).toBe("▱▱▱▱▱▱▱▱");
    expect(hpBar(1, 9)).toBe("▰▱▱▱▱▱▱▱");
    expect(hpBar(20, 9)).toBe("▰▰▰▰▰▰▰▰");
    expect(hpBar(-3, 9)).toBe("▱▱▱▱▱▱▱▱");
  });
});
