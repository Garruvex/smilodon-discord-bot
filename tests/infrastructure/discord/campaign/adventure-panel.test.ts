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
    expect(card.buttons.map((button) => button.id)).toEqual(["dnd:act:camp", "dnd:speak:camp", "dnd:pass:camp", "dnd:myHero:camp", "dnd:away:camp", "dnd:explore:camp", "dnd:safety:camp", "dnd:more:camp", "dnd:back:camp"]);
  });

  it("shows the story's day, time and weather when the adventure keeps a clock, and nothing when it does not", () => {
    const world = { day: 2, time: "dusk", weather: "rain" };
    expect(flatten(renderAdventurePanel({ ...collecting, world }, texts.en, "camp")).text).toContain("Day 2 · dusk · rain");
    expect(flatten(renderAdventurePanel({ ...collecting, world }, texts["zh-TW"], "camp")).text).toContain("第 2 天 · 黃昏 · 下雨");
    expect(flatten(renderAdventurePanel(collecting, texts.en, "camp")).text).not.toContain("Day ");
  });

  it("says so when there is no timer", () => {
    expect(flatten(renderAdventurePanel({ ...collecting, closesAt: null }, texts.en, "camp")).text).toContain("No timer.");
  });

  it("changes its controls with the state", () => {
    expect(labels({ ...collecting, mode: "planning" })).toEqual(["My Hero", "Away", "Explore", "Safety", "More…", "I'm back"]);
    expect(labels({ ...collecting, mode: "awaitingRolls", pendingRolls: [{ characterId: "c-mira", userId: "1", heroName: "Mira" }] })).toEqual(["My Hero", "Away", "Explore", "Safety", "More…", "I'm back"]);
    expect(labels({ ...collecting, mode: "waiting" })).toEqual(["Continue", "I'm back", "My Hero", "Explore", "Safety", "More…"]);
    expect(labels({ ...collecting, mode: "paused" })).toEqual(["My Hero", "Explore", "Safety", "More…", "I'm back"]);
    expect(labels({ ...collecting, mode: "archived" })).toEqual([]);
  });

  it("asks everyone to press Ready after the opening, showing who has", () => {
    const view: PanelView = {
      ...collecting,
      mode: "readyCheck",
      roundNumber: null,
      closesAt: null,
      roster: [
        { characterId: "c-mira", userId: "1", heroName: "Mira", status: "ready" },
        { characterId: "c-borin", userId: "2", heroName: "Borin", status: "thinking" },
      ],
    };
    const card = flatten(renderAdventurePanel(view, texts.en, "camp"));
    expect(card.text).toContain("Getting ready");
    expect(card.text).toContain("Press Ready");
    expect(card.text).toContain("Mira ✓ Ready · Borin … Thinking");
    expect(card.buttons.map((button) => button.id)).toEqual(["dnd:ready:camp", "dnd:begin:camp", "dnd:myHero:camp", "dnd:away:camp", "dnd:explore:camp", "dnd:safety:camp", "dnd:more:camp", "dnd:back:camp"]);
    expect(labels(view, "zh-TW")).toEqual(["準備好了", "立即開始", "我的英雄", "離開", "探索", "安全", "更多…", "我回來了"]);
  });

  it("explains a pause and a restart pause in words, on a gray card", () => {
    const paused = flatten(renderAdventurePanel({ ...collecting, mode: "paused" }, texts.en, "camp"));
    expect(paused.accent).toBe(accents.gray);
    expect(paused.text).toContain("Paused");
    expect(paused.text).toContain("The organizer paused the campaign.");
    expect(flatten(renderAdventurePanel({ ...collecting, mode: "recovery" }, texts.en, "camp")).text).toContain("The organizer must resume play.");
  });

  it("names who the rolls wait for and points them to their private hero screen", () => {
    const view: PanelView = { ...collecting, mode: "awaitingRolls", pendingRolls: [{ characterId: "c-mira", userId: "1", heroName: "Mira" }] };
    const card = flatten(renderAdventurePanel(view, texts.en, "camp"));
    expect(card.accent).toBe(accents.amber);
    expect(card.text).toContain("Waiting for rolls: Mira. If this is your hero, open My Hero to roll.");
    expect(card.buttons.map((button) => button.label)).not.toContain("Roll");
  });

  it("separates both sides with health bars, exact HP, and locations", () => {
    const view: PanelView = {
      ...collecting,
      mode: "combat",
      closesAt: null,
      combat: {
        round: 2,
        activeName: "Borin",
        activeUserId: "2",
        playersControl: false,
        zones: ["Cellar", "Stairs"],
        party: [
          { name: "Mira", hp: 4, maxHp: 9, tempHp: 0, condition: "active", zone: "Cellar", active: false },
          { name: "Borin", hp: 12, maxHp: 12, tempHp: 0, condition: "active", zone: "Cellar", active: true },
        ],
        foes: [
          { name: "Goblin A", hp: 2, maxHp: 7, band: "bloodied", zone: "Cellar", active: false },
          { name: "Wolf", hp: 11, maxHp: 11, band: "unhurt", zone: "Stairs", active: false },
        ],
      },
    };
    const card = flatten(renderAdventurePanel(view, texts.en, "camp"));
    expect(card.accent).toBe(accents.red);
    expect(card.text).toContain("▶ **Borin** is taking their turn.");
    expect(card.text).toContain("### Party (2)\n▶ **Borin**");
    expect(card.text).toContain("▰▰▰▰▰▰▰▰ HP 12/12 · 📍 Cellar");
    expect(card.text).toContain("• **Mira** · ▰▰▰▰▱▱▱▱ HP 4/9");
    expect(card.text).toContain("### Enemies (2)\n• **Goblin A**");
    expect(card.text).toContain("HP 2/7 · bloodied · 📍 Cellar");
    expect(card.text).toContain("HP 11/11 · unhurt · 📍 Stairs");
    // On autopilot nobody takes turns, so there is only My Hero (and the safety row).
    expect(card.buttons.map((button) => button.id)).toEqual(["dnd:myHero:camp", "dnd:safety:camp", "dnd:more:camp", "dnd:back:camp"]);
  });

  it("gives a fight the players play a Take turn and End turn button", () => {
    const view: PanelView = {
      ...collecting,
      mode: "combat",
      closesAt: 1_800_000_000_000,
      combat: {
        round: 1,
        activeName: "Mira",
        activeUserId: "1",
        playersControl: true,
        zones: ["Cellar"],
        party: [{ name: "Mira", hp: 9, maxHp: 9, tempHp: 0, condition: "active", zone: "Cellar", active: true }],
        foes: [{ name: "Wolf", hp: 11, maxHp: 11, band: "unhurt", zone: "Cellar", active: false }],
      },
    };
    const card = flatten(renderAdventurePanel(view, texts.en, "camp"));
    expect(card.text).toContain("\nTurn deadline: <t:1800000000:d> <t:1800000000:t>");
    expect(card.buttons.map((button) => button.id)).toEqual(["dnd:turn:camp", "dnd:endTurn:camp", "dnd:speak:camp", "dnd:myHero:camp", "dnd:away:camp", "dnd:safety:camp", "dnd:more:camp", "dnd:back:camp"]);
    expect(labels(view, "zh-TW")).toEqual(["輪到我", "結束回合", "說話", "我的英雄", "離開", "安全", "更多…", "我回來了"]);
  });

  it("speaks Traditional Chinese with short labels, and stays within Discord's limits", () => {
    const card = flatten(renderAdventurePanel(collecting, texts["zh-TW"], "camp"));
    expect(card.text).toContain("Old Watchtower · 探索 · 第 4 回合");
    expect(card.text).toContain("Mira ✓ 已提交 · Borin … 思考中 · Elin — 離開");
    expect(card.buttons.map((button) => button.label)).toEqual(["行動／修改", "說話", "跳過", "我的英雄", "離開", "探索", "安全", "更多…", "我回來了"]);
    expect(card.componentCount).toBeLessThan(cardLimits.components);
    expect(card.text.length).toBeLessThan(cardLimits.characters);
  });

  it("shows Chinese health, temporary HP and incapacitation with a separate deadline", () => {
    const view: PanelView = {
      ...collecting, mode: "combat", roundNumber: 1,
      combat: {
        round: 1, activeName: "空虎", activeUserId: "1", playersControl: true, zones: ["辦公室"],
        party: [
          { name: "空虎", hp: 10, maxHp: 10, tempHp: 3, condition: "active", zone: "辦公室", active: true },
          { name: "Onyx", hp: -2, maxHp: 8, tempHp: 0, condition: "unconscious", zone: "辦公室", active: false },
        ],
        foes: [{ name: "飛蛇", hp: 2, maxHp: 5, band: "bloodied", zone: "辦公室", active: false }],
      },
    };
    const card = flatten(renderAdventurePanel(view, texts["zh-TW"], "camp"));
    expect(card.text).toContain("▶ 輪到 **空虎** 行動\n行動截止時間：<t:1800000000:d> <t:1800000000:t>");
    expect(card.text).toContain("### 隊伍（2）\n▶ **空虎** · ▰▰▰▰▰▰▰▰ 生命 10/10 · +3 臨時生命值");
    expect(card.text).toContain("• **Onyx** · ▱▱▱▱▱▱▱▱ 生命 0/8 · 倒地");
    expect(card.text).toContain("### 敵方（1）\n• **飛蛇** · ▰▰▰▰▱▱▱▱ 生命 2/5 · 重傷");
    expect(card.text).not.toContain(":R>");
  });

  it("keeps a crowded fight within message limits with the active enemy visible", () => {
    const view: PanelView = {
      ...collecting, mode: "combat",
      combat: {
        round: 1, activeName: "Last enemy", activeUserId: null, playersControl: true, zones: ["Cellar", "Stairs"],
        party: Array.from({ length: 30 }, (_, i) => ({ name: `Hero ${i} with a long name`, hp: 5, maxHp: 10, tempHp: 0, condition: "active" as const, zone: "Cellar", active: false })),
        foes: Array.from({ length: 100 }, (_, i) => ({ name: i === 99 ? "Last enemy" : `Enemy ${i} with a long name`, hp: 3, maxHp: 7, band: "bloodied" as const, zone: "Stairs", active: i === 99 })),
      },
    };
    const card = flatten(renderAdventurePanel(view, texts.en, "camp"));
    expect(card.text).toContain("### Party (30)");
    expect(card.text).toContain("### Enemies (100)\n▶ **Last enemy**");
    expect(card.text).toContain("more combatants");
    expect(card.text.length).toBeLessThan(cardLimits.characters);
    expect(card.componentCount).toBeLessThan(cardLimits.components);
  });
});

const hero: HeroView = {
  characterId: "c-mira",
  ownerUserId: "42",
  name: "Mira",
  tempHp: 0,
  className: "Rogue",
  level: 1,
  hp: 4,
  maxHp: 9,
  armorClass: 14,
  conditions: ["condition:prone"],
  presence: "present",
  down: false,
  fallen: false,
  worn: [],
  weapons: [],
  pack: [],
  gold: 0,
  partyGold: 0,
  stash: [],
  cantrips: [],
  prepared: [],
  slots: [],
  pactSlots: [],
  uses: [],
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

  it("always shows gear, pack, gold, stash, spells, slots, and limited uses", () => {
    const loaded: HeroView = {
      ...hero,
      worn: ["item:chain-mail"],
      weapons: ["item:mace"],
      pack: [{ id: "item:healing-potion", count: 2 }],
      gold: 5,
      partyGold: 12,
      stash: ["item:shortbow"],
      cantrips: ["spell:sacred-flame"],
      prepared: ["spell:bless", "spell:cure-wounds"],
      slots: [{ level: 1, left: 1, max: 2 }],
      pactSlots: [{ level: 1, left: 1, max: 2 }],
      uses: [{ id: "feature:second-wind", left: 0, max: 1 }],
    };
    const card = flatten(renderHeroCard(loaded, texts.en, "camp", (id) => id.split(":")[1] ?? id)).text;
    expect(card).toContain("🛡️ **Wearing:** chain-mail");
    expect(card).toContain("⚔️ **Weapons:** mace");
    expect(card).toContain("🎒 **Pack:** healing-potion ×2");
    expect(card).toContain("🪙 **Gold:** 5 · Party purse 12");
    expect(card).toContain("🧰 **Party stash:** shortbow");
    expect(card).toContain("✨ **Cantrips:** sacred-flame · **Prepared:** bless, cure-wounds");
    expect(card).toContain("🔮 **Spell slots:** Level 1 1/2");
    // A Warlock's Pact Magic is its own pool, shown as its own line.
    expect(card).toContain("🔮 **Pact slots:** Level 1 1/2");
    expect(card).toContain("⚡ **Uses:** second-wind 0/1");

    const zh = flatten(renderHeroCard(loaded, texts["zh-TW"], "camp", (id) => id.split(":")[1] ?? id)).text;
    expect(zh).toContain("🛡️ **穿戴：**chain-mail");
    expect(zh).toContain("🪙 **金幣：**5 · 隊伍公庫 12");
    expect(zh).toContain("🔮 **法術位：**1 環 1/2");
    expect(zh).toContain("🔮 **契約法術位：**1 環 1/2");
  });

  it("shows an empty pack and no spell lines for a hero without them", () => {
    const card = flatten(renderHeroCard(hero, texts.en, "camp", String)).text;
    expect(card).toContain("🎒 **Pack:** empty");
    expect(card).toContain("🪙 **Gold:** 0");
    expect(card).not.toContain("Party purse");
    expect(card).not.toContain("Cantrips");
    expect(card).not.toContain("Party stash");
    expect(card).not.toContain("Uses:");
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
