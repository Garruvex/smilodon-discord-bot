import { describe, expect, it } from "vitest";

import { newCampaign, jamie, organizer, run, reject, system, d20Roll } from "./campaign-fixtures.js";

// Borin (fixture default): CON 15 (+2), proficient in Constitution saves, so
// +4 against the hazard DC.

describe("faceHazard", () => {
  it("rejects a non-organizer", () => {
    const state = newCampaign();
    expect(reject(state, jamie, { kind: "faceHazard", characterId: "c-borin", ability: "con", dc: 12 })).toEqual({ code: "notOrganizer" });
  });

  it("rejects a second hazard while one is already pending", () => {
    const declared = run(newCampaign(), organizer, { kind: "faceHazard", characterId: "c-borin", ability: "con", dc: 12 });
    expect(reject(declared.state, organizer, { kind: "faceHazard", characterId: "c-borin", ability: "con", dc: 12 })).toEqual({
      code: "hazardAlreadyPending",
    });
  });

  it("requests a real d20 saving throw rather than deciding anything itself", () => {
    const declared = run(newCampaign(), organizer, { kind: "faceHazard", characterId: "c-borin", ability: "con", dc: 12 });
    const pending = declared.state.hazardPending?.["c-borin"];
    expect(pending).toMatchObject({ ability: "con", dc: 12 });
    expect(declared.requests).toContainEqual({ kind: "roll", rollId: pending?.rollId, spec: { kind: "d20Test", spec: pending?.spec } });
  });

  it("a beaten DC costs nothing, even for a hero with no prior hero status at all", () => {
    const state = newCampaign(); // heroStatus starts empty — nobody has fought or rested yet.
    const declared = run(state, organizer, { kind: "faceHazard", characterId: "c-borin", ability: "con", dc: 12 });
    const rollId = declared.state.hazardPending?.["c-borin"]?.rollId ?? "";
    // Modifier +4: natural 12 -> total 16, beats DC 12.
    const roll = d20Roll("normal", [12], 4);
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    expect(settled.state.hazardPending?.["c-borin"]).toBeUndefined();
    expect(settled.state.heroStatus["c-borin"]?.exhaustion ?? 0).toBe(0);
    const hazardId = Object.keys(settled.state.hazards)[0] ?? "";
    expect(settled.state.hazards[hazardId]).toMatchObject({ success: true, total: 16, dc: 12, exhaustionGained: 0 });
  });

  it("a missed DC grants a level of Exhaustion, defaulting the hero's status if they never had one", () => {
    const state = newCampaign();
    const declared = run(state, organizer, { kind: "faceHazard", characterId: "c-borin", ability: "con", dc: 20 });
    const rollId = declared.state.hazardPending?.["c-borin"]?.rollId ?? "";
    // Modifier +4: natural 2 -> total 6, well under DC 20.
    const roll = d20Roll("normal", [2], 4);
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    expect(settled.state.heroStatus["c-borin"]).toMatchObject({ hp: 12, exhaustion: 1 });
    const hazardId = Object.keys(settled.state.hazards)[0] ?? "";
    expect(settled.state.hazards[hazardId]).toMatchObject({ success: false, exhaustionGained: 1 });
  });

  it("stacks onto an existing level of Exhaustion instead of overwriting it", () => {
    const base = newCampaign();
    const state = { ...base, heroStatus: { ...base.heroStatus, "c-borin": { hp: 12, resources: { spellSlots: {}, featureUses: {} }, exhaustion: 2 } } };
    const declared = run(state, organizer, { kind: "faceHazard", characterId: "c-borin", ability: "con", dc: 20 });
    const rollId = declared.state.hazardPending?.["c-borin"]?.rollId ?? "";
    // Exhaustion 1+ already imposes disadvantage on the roll itself.
    const roll = d20Roll("disadvantage", [2, 10], 4);
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    expect(settled.state.heroStatus["c-borin"]?.exhaustion).toBe(3);
  });
});

describe("recordHazardNarration", () => {
  it("is system-only and clears the settled hazard once narrated", () => {
    const declared = run(newCampaign(), organizer, { kind: "faceHazard", characterId: "c-borin", ability: "con", dc: 12 });
    const rollId = declared.state.hazardPending?.["c-borin"]?.rollId ?? "";
    const roll = d20Roll("normal", [12], 4);
    const settled = run(declared.state, system, { kind: "recordRoll", rollId, result: { kind: "d20Test", roll } });
    const hazardId = Object.keys(settled.state.hazards)[0] ?? "";
    expect(reject(settled.state, organizer, { kind: "recordHazardNarration", hazardId, text: "The storm passes." })).toEqual({ code: "systemOnly" });
    const narrated = run(settled.state, system, { kind: "recordHazardNarration", hazardId, text: "The storm passes." });
    expect(narrated.state.hazards[hazardId]).toBeUndefined();
  });

  it("rejects narrating a hazard that no longer exists", () => {
    expect(reject(newCampaign(), system, { kind: "recordHazardNarration", hazardId: "hazard:999", text: "..." })).toEqual({ code: "staleNarration" });
  });
});
