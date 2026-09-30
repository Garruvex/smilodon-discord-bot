import { describe, expect, it } from "vitest";

import { deriveSheet, type BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { newCampaign, jamie, organizer, run, reject, system } from "./campaign-fixtures.js";

const wizardBuild: BuildChoices = {
  class: "wizard",
  kit: "scholar",
  abilities: { str: 8, dex: 12, con: 14, int: 16, wis: 13, cha: 10 },
  skills: ["arcana", "investigation"],
  expertise: [],
  name: "Rowan",
  appearance: "",
  backstory: "",
};

function rowan(): CharacterSheet {
  return { ...deriveSheet(wizardBuild), id: "c-borin", ownerUserId: "u-jamie" };
}

function campaignWithRowan(): CampaignState {
  const base = newCampaign();
  return { ...base, characters: { ...base.characters, "c-borin": rowan() } };
}

describe("castRitualSpell", () => {
  it("casts a cantrip free and queues a narration, without touching gold or slots", () => {
    const state = campaignWithRowan();
    const step = run(state, jamie, { kind: "castRitualSpell", characterId: "c-borin", spellId: "spell:mage-hand" });
    const castId = Object.keys(step.state.utilityCasts)[0];
    expect(castId).toBeDefined();
    expect(step.state.utilityCasts[castId ?? ""]).toMatchObject({ characterId: "c-borin", spellId: "spell:mage-hand" });
    expect(step.requests).toContainEqual({ kind: "narrateUtilityCast", castId });
    expect(step.state.characters["c-borin"]).toMatchObject(rowan());
  });

  it("casts a ritual-tagged leveled spell free too", () => {
    const state = campaignWithRowan();
    const step = run(state, jamie, { kind: "castRitualSpell", characterId: "c-borin", spellId: "spell:detect-magic" });
    const castId = Object.keys(step.state.utilityCasts)[0] ?? "";
    expect(step.state.utilityCasts[castId]).toMatchObject({ spellId: "spell:detect-magic" });
  });

  it("rejects a leveled spell that isn't ritual-tagged", () => {
    const state = campaignWithRowan();
    // Rowan knows Magic Missile (level 1, not a ritual) from the wizard template.
    expect(reject(state, jamie, { kind: "castRitualSpell", characterId: "c-borin", spellId: "spell:magic-missile" })).toEqual({
      code: "notARitualSpell",
    });
  });

  it("rejects a spell the hero doesn't know", () => {
    const state = campaignWithRowan();
    // Cure Wounds isn't on the wizard template's known-spell list.
    expect(reject(state, jamie, { kind: "castRitualSpell", characterId: "c-borin", spellId: "spell:cure-wounds" })).toEqual({ code: "unknownSpell" });
  });

  it("rejects content that isn't a real spell", () => {
    const state = campaignWithRowan();
    expect(reject(state, jamie, { kind: "castRitualSpell", characterId: "c-borin", spellId: "spell:not-a-real-spell" })).toEqual({ code: "unknownSpell" });
  });

  it("rejects someone else's hero", () => {
    const state = campaignWithRowan();
    expect(reject(state, organizer, { kind: "castRitualSpell", characterId: "c-borin", spellId: "spell:mage-hand" })).toEqual({ code: "notYourCharacter" });
  });
});

describe("recordUtilityCastNarration", () => {
  it("is system-only and clears the settled cast once narrated", () => {
    const state = campaignWithRowan();
    const cast = run(state, jamie, { kind: "castRitualSpell", characterId: "c-borin", spellId: "spell:mage-hand" });
    const castId = Object.keys(cast.state.utilityCasts)[0] ?? "";
    expect(reject(cast.state, jamie, { kind: "recordUtilityCastNarration", castId, text: "A ghostly hand appears." })).toEqual({ code: "systemOnly" });
    const narrated = run(cast.state, system, { kind: "recordUtilityCastNarration", castId, text: "A ghostly hand appears." });
    expect(narrated.state.utilityCasts[castId]).toBeUndefined();
  });

  it("rejects narrating a cast that no longer exists", () => {
    expect(reject(newCampaign(), system, { kind: "recordUtilityCastNarration", castId: "cast:999", text: "..." })).toEqual({
      code: "staleNarration",
    });
  });
});
