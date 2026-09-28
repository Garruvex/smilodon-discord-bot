import { describe, expect, it } from "vitest";

import { deriveSheet, type BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { newCampaign, jamie, organizer, ruleset, run, reject, system, d20Roll, type Step } from "./campaign-fixtures.js";

// A level-1 Bard: CHA 16 (+3), proficient in Persuasion and Deception, so a
// +5 modifier against the haggle DC of 15 — round numbers to reason about.
const bardBuild: BuildChoices = {
  class: "bard",
  kit: "lore",
  abilities: { str: 8, dex: 12, con: 14, int: 10, wis: 13, cha: 16 },
  skills: ["persuasion", "deception", "insight"],
  expertise: [],
  name: "Sable",
  appearance: "",
  backstory: "",
};

function sable(): CharacterSheet {
  return { ...deriveSheet(bardBuild), id: "c-borin", ownerUserId: "u-jamie" };
}

function campaignWithSable(): CampaignState {
  const base = newCampaign();
  return { ...base, characters: { ...base.characters, "c-borin": sable() } };
}

describe("buyItem", () => {
  it("deducts the party purse and gives the hero the item, then queues a trade narration", () => {
    const state = { ...campaignWithSable(), gold: 100 };
    const step = run(state, jamie, { kind: "buyItem", characterId: "c-borin", npcId: "npc:smith", itemId: "item:dagger", price: 20 });
    expect(step.state.gold).toBe(80);
    expect(step.state.characters["c-borin"]?.equipment).toContain("item:dagger");
    const tradeId = Object.keys(step.state.trades)[0];
    expect(tradeId).toBeDefined();
    expect(step.state.trades[tradeId ?? ""]).toMatchObject({ direction: "buy", listedPrice: 20, finalPrice: 20, outcome: "completed", haggle: null });
    expect(step.requests).toContainEqual({ kind: "narrateTrade", tradeId });
  });

  it("rejects a purchase the party can't afford", () => {
    const state = { ...campaignWithSable(), gold: 5 };
    expect(reject(state, jamie, { kind: "buyItem", characterId: "c-borin", npcId: "npc:smith", itemId: "item:dagger", price: 20 })).toEqual({
      code: "insufficientGold",
    });
  });

  it("rejects an item that isn't real content", () => {
    const state = { ...campaignWithSable(), gold: 100 };
    expect(reject(state, jamie, { kind: "buyItem", characterId: "c-borin", npcId: "npc:smith", itemId: "item:not-a-real-item", price: 1 })).toEqual({
      code: "unknownItem",
    });
  });

  it("draws from the hero's own share under the split loot house rule", () => {
    const base = { ...campaignWithSable(), gold: 0, heroGold: { "c-borin": 50 } };
    const step = run(base, jamie, { kind: "buyItem", characterId: "c-borin", npcId: "npc:smith", itemId: "item:dagger", price: 20 }, { rules: ruleset({ "loot-gold": "split" }) });
    expect(step.state.heroGold?.["c-borin"]).toBe(30);
    expect(step.state.gold).toBe(0);
  });

  it("rejects someone else spending a hero's gold", () => {
    const state = { ...campaignWithSable(), gold: 100 };
    expect(reject(state, organizer, { kind: "buyItem", characterId: "c-borin", npcId: "npc:smith", itemId: "item:dagger", price: 20 })).toEqual({
      code: "notYourCharacter",
    });
  });
});

describe("sellItem", () => {
  it("removes the item and pays the party purse", () => {
    const state = { ...campaignWithSable(), gold: 0 };
    const step = run(state, jamie, { kind: "sellItem", characterId: "c-borin", npcId: "npc:smith", itemId: "item:rapier", price: 5 });
    expect(step.state.gold).toBe(5);
    expect(step.state.characters["c-borin"]?.equipment).not.toContain("item:rapier");
  });

  it("rejects selling an item the hero doesn't hold", () => {
    const state = campaignWithSable();
    expect(reject(state, jamie, { kind: "sellItem", characterId: "c-borin", npcId: "npc:smith", itemId: "item:longsword", price: 5 })).toEqual({
      code: "itemNotHeld",
    });
  });
});

describe("hagglePrice", () => {
  function haggle(gold: number, direction: "buy" | "sell"): Step {
    const state = { ...campaignWithSable(), gold };
    return run(state, jamie, { kind: "hagglePrice", characterId: "c-borin", npcId: "npc:smith", itemId: "item:dagger", direction, listedPrice: 20, skill: "persuasion" });
  }

  it("rejects a skill that isn't Persuasion, Deception, or Intimidation", () => {
    const state = { ...campaignWithSable(), gold: 100 };
    expect(
      reject(state, jamie, { kind: "hagglePrice", characterId: "c-borin", npcId: "npc:smith", itemId: "item:dagger", direction: "buy", listedPrice: 20, skill: "athletics" }),
    ).toEqual({ code: "invalidHaggleSkill" });
  });

  it("rejects a second haggle while one is already pending", () => {
    const declared = haggle(100, "buy");
    expect(
      reject(declared.state, jamie, {
        kind: "hagglePrice",
        characterId: "c-borin",
        npcId: "npc:smith",
        itemId: "item:dagger",
        direction: "buy",
        listedPrice: 20,
        skill: "persuasion",
      }),
    ).toEqual({ code: "haggleAlreadyPending" });
  });

  it("requests a real d20 roll rather than deciding anything itself", () => {
    const declared = haggle(100, "buy");
    const pending = declared.state.hagglePending?.["c-borin"];
    expect(pending).toMatchObject({ dc: 15, direction: "buy", listedPrice: 20 });
    expect(declared.requests).toContainEqual({ kind: "roll", rollId: pending?.rollId, spec: { kind: "d20Test", spec: pending?.spec } });
  });

  it("beating the DC discounts a buy, scaling with the margin (2% per point, capped at 25%)", () => {
    const declared = haggle(100, "buy");
    const rollId = declared.state.hagglePending?.["c-borin"]?.rollId ?? "";
    // Modifier +5 (Bard, Persuasion): natural 15 -> total 20, 5 over DC 15 -> 10% off.
    const roll = d20Roll("normal", [15], 5);
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    expect(settled.state.hagglePending?.["c-borin"]).toBeUndefined();
    expect(settled.state.gold).toBe(100 - 18); // 20 * 0.90 = 18.
    expect(settled.state.characters["c-borin"]?.equipment).toContain("item:dagger");
    const tradeId = Object.keys(settled.state.trades)[0] ?? "";
    expect(settled.state.trades[tradeId]).toMatchObject({ finalPrice: 18, outcome: "completed" });
    expect(settled.state.trades[tradeId]?.haggle).toMatchObject({ success: true, total: 20, dc: 15 });
  });

  it("missing the DC changes nothing about the price", () => {
    const declared = haggle(100, "buy");
    const rollId = declared.state.hagglePending?.["c-borin"]?.rollId ?? "";
    // Modifier +5: natural 2 -> total 7, well under DC 15.
    const roll = d20Roll("normal", [2], 5);
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    expect(settled.state.gold).toBe(80); // Full listed price, not a worse one.
    const tradeId = Object.keys(settled.state.trades)[0] ?? "";
    expect(settled.state.trades[tradeId]).toMatchObject({ finalPrice: 20, outcome: "completed" });
    expect(settled.state.trades[tradeId]?.haggle?.success).toBe(false);
  });

  it("a successful haggle that still costs more than the hero has completes nothing, but is still recorded for narration", () => {
    const declared = haggle(15, "buy"); // Only 15 gold on hand, against a listed price of 20.
    const rollId = declared.state.hagglePending?.["c-borin"]?.rollId ?? "";
    const roll = d20Roll("normal", [15], 5); // A real 10% discount (total 20, DC 15) still leaves 18 to find.
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    expect(settled.state.gold).toBe(15); // Nothing spent.
    expect(settled.state.characters["c-borin"]?.equipment).not.toContain("item:dagger");
    const tradeId = Object.keys(settled.state.trades)[0] ?? "";
    expect(settled.state.trades[tradeId]?.outcome).toBe("cannotAfford");
  });

  it("scales a sell's markup the same way, in the shop's favor going down instead of up", () => {
    const state = { ...campaignWithSable(), gold: 0 };
    const declared = run(state, jamie, {
      kind: "hagglePrice",
      characterId: "c-borin",
      npcId: "npc:smith",
      itemId: "item:rapier",
      direction: "sell",
      listedPrice: 20,
      skill: "persuasion",
    });
    const rollId = declared.state.hagglePending?.["c-borin"]?.rollId ?? "";
    const roll = d20Roll("normal", [20], 5); // total 25, 10 over DC 15 -> +20%.
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    expect(settled.state.gold).toBe(24); // 20 * 1.20 = 24.
  });
});

describe("recordTradeNarration", () => {
  it("is system-only and clears the settled trade once narrated", () => {
    const state = { ...campaignWithSable(), gold: 100 };
    const bought = run(state, jamie, { kind: "buyItem", characterId: "c-borin", npcId: "npc:smith", itemId: "item:dagger", price: 20 });
    const tradeId = Object.keys(bought.state.trades)[0] ?? "";
    expect(reject(bought.state, jamie, { kind: "recordTradeNarration", tradeId, text: "The smith nods." })).toEqual({ code: "systemOnly" });
    const narrated = run(bought.state, system, { kind: "recordTradeNarration", tradeId, text: "The smith nods." });
    expect(narrated.state.trades[tradeId]).toBeUndefined();
  });

  it("rejects narrating a trade that no longer exists", () => {
    expect(reject(newCampaign(), system, { kind: "recordTradeNarration", tradeId: "trade:999", text: "..." })).toEqual({ code: "staleNarration" });
  });
});
