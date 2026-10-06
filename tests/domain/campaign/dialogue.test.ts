import { describe, expect, it } from "vitest";

import { deriveSheet, type BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { kinds, newCampaign, jamie, organizer, run, reject, system, d20Roll, type Step } from "./campaign-fixtures.js";

// The same Bard as shop.test.ts: CHA 16 (+3), proficient in Persuasion,
// Deception, and Insight, so a +5 modifier against the press DC of 20.
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

describe("askNpc", () => {
  it("records a plain question and queues a dialogue narration", () => {
    const state = campaignWithSable();
    const step = run(state, jamie, { kind: "askNpc", characterId: "c-borin", npcId: "npc:smith", question: "Any rumors about the road north?" });
    const dialogueId = Object.keys(step.state.dialogues)[0];
    expect(dialogueId).toBeDefined();
    expect(step.state.dialogues[dialogueId ?? ""]).toMatchObject({ kind: "ask", question: "Any rumors about the road north?", check: null });
    expect(step.requests).toContainEqual({ kind: "narrateDialogue", dialogueId });
  });

  it("rejects an empty question", () => {
    const state = campaignWithSable();
    expect(reject(state, jamie, { kind: "askNpc", characterId: "c-borin", npcId: "npc:smith", question: "   " })).toEqual({ code: "emptyAction" });
  });

  it("rejects a question that's too long", () => {
    const state = campaignWithSable();
    expect(reject(state, jamie, { kind: "askNpc", characterId: "c-borin", npcId: "npc:smith", question: "x".repeat(1001) })).toEqual({
      code: "actionTooLong",
      maxLength: 1000,
    });
  });

  it("rejects someone else's hero", () => {
    const state = campaignWithSable();
    expect(reject(state, organizer, { kind: "askNpc", characterId: "c-borin", npcId: "npc:smith", question: "Hello?" })).toEqual({ code: "notYourCharacter" });
  });
});

describe("pressNpc", () => {
  function press(): Step {
    return run(campaignWithSable(), jamie, { kind: "pressNpc", characterId: "c-borin", npcId: "npc:smith", skill: "persuasion" });
  }

  it("rejects a skill that isn't Persuasion, Deception, Intimidation, or Insight", () => {
    const state = campaignWithSable();
    expect(reject(state, jamie, { kind: "pressNpc", characterId: "c-borin", npcId: "npc:smith", skill: "athletics" })).toEqual({ code: "invalidPressSkill" });
  });

  it("rejects a second press while one is already pending", () => {
    const declared = press();
    expect(reject(declared.state, jamie, { kind: "pressNpc", characterId: "c-borin", npcId: "npc:smith", skill: "persuasion" })).toEqual({
      code: "pressAlreadyPending",
    });
  });

  it("requests a real d20 roll rather than deciding anything itself", () => {
    const declared = press();
    const pending = declared.state.pressPending?.["c-borin"];
    expect(pending).toMatchObject({ dc: 20, npcId: "npc:smith" });
    expect(declared.requests).toContainEqual({ kind: "roll", rollId: pending?.rollId, spec: { kind: "d20Test", spec: pending?.spec } });
  });

  it("beating the DC reveals the NPC's secret for good", () => {
    const declared = press();
    const rollId = declared.state.pressPending?.["c-borin"]?.rollId ?? "";
    // Modifier +5: natural 15 -> total 20, meets DC 20.
    const roll = d20Roll("normal", [15], 5);
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    expect(settled.state.pressPending?.["c-borin"]).toBeUndefined();
    expect(settled.state.npcSecretsRevealed?.["npc:smith"]).toBe(true);
    const dialogueId = Object.keys(settled.state.dialogues)[0] ?? "";
    expect(settled.state.dialogues[dialogueId]).toMatchObject({ kind: "press", question: null });
    expect(settled.state.dialogues[dialogueId]?.check).toMatchObject({ success: true, total: 20, dc: 20 });
  });

  it("missing the DC gives up nothing", () => {
    const declared = press();
    const rollId = declared.state.pressPending?.["c-borin"]?.rollId ?? "";
    // Modifier +5: natural 2 -> total 7, well under DC 20.
    const roll = d20Roll("normal", [2], 5);
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    expect(settled.state.npcSecretsRevealed?.["npc:smith"]).toBeUndefined();
    const dialogueId = Object.keys(settled.state.dialogues)[0] ?? "";
    expect(settled.state.dialogues[dialogueId]?.check?.success).toBe(false);
  });

  it("rejects a repeat press after the first attempt reveals the secret", () => {
    const declared = press();
    const rollId = declared.state.pressPending?.["c-borin"]?.rollId ?? "";
    const roll = d20Roll("normal", [15], 5);
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    expect(reject(settled.state, jamie, { kind: "pressNpc", characterId: "c-borin", npcId: "npc:smith", skill: "deception" })).toEqual({
      code: "pressAlreadyAttempted",
    });
  });

  it("rejects a revealed secret even when this hero has never pressed the NPC", () => {
    const state = { ...campaignWithSable(), npcSecretsRevealed: { "npc:smith": true } };
    expect(reject(state, jamie, { kind: "pressNpc", characterId: "c-borin", npcId: "npc:smith", skill: "deception" })).toEqual({ code: "secretAlreadyRevealed" });
  });
});

describe("recordDialogueNarration", () => {
  it("is system-only and clears the settled dialogue once narrated", () => {
    const state = campaignWithSable();
    const asked = run(state, jamie, { kind: "askNpc", characterId: "c-borin", npcId: "npc:smith", question: "Anything I should know?" });
    const dialogueId = Object.keys(asked.state.dialogues)[0] ?? "";
    expect(reject(asked.state, jamie, { kind: "recordDialogueNarration", dialogueId, text: "The smith shrugs." })).toEqual({ code: "systemOnly" });
    const narrated = run(asked.state, system, { kind: "recordDialogueNarration", dialogueId, text: "The smith shrugs." });
    expect(narrated.state.dialogues[dialogueId]).toBeUndefined();
  });

  it("teaches the party what the NPC told, once, and never again", () => {
    const asked = run(campaignWithSable(), jamie, { kind: "askNpc", characterId: "c-borin", npcId: "npc:smith", question: "Who forged this blade?" });
    const dialogueId = Object.keys(asked.state.dialogues)[0] ?? "";
    const told = run(asked.state, system, { kind: "recordDialogueNarration", dialogueId, text: "He forged it himself.", reveals: [{ clueId: "clue:the-smith-forged-it", text: "The smith forged the blade himself." }] });
    expect(kinds(told.events)).toContain("clueRevealed");
    expect(told.state.clues).toContainEqual({ id: "clue:the-smith-forged-it", text: "The smith forged the blade himself." });
    // The same clue told again is not added twice.
    const again = run(told.state, jamie, { kind: "askNpc", characterId: "c-borin", npcId: "npc:smith", question: "Who forged this blade again?" });
    const id2 = Object.keys(again.state.dialogues)[0] ?? "";
    const twice = run(again.state, system, { kind: "recordDialogueNarration", dialogueId: id2, text: "Yes.", reveals: [{ clueId: "clue:the-smith-forged-it", text: "The smith forged the blade himself." }] });
    expect(twice.state.clues.filter((clue) => clue.id === "clue:the-smith-forged-it")).toHaveLength(1);
  });

  it("rejects narrating a dialogue that no longer exists", () => {
    expect(reject(newCampaign(), system, { kind: "recordDialogueNarration", dialogueId: "dialogue:999", text: "..." })).toEqual({ code: "staleNarration" });
  });
});
