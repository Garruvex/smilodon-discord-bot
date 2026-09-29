import { describe, expect, it } from "vitest";

import { deriveSheet, type BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { performRoll } from "../../../src/domain/campaign/dice/roll-spec.js";
import type { CampaignCommand } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, newCampaign, reject, run, system, type Step } from "./campaign-fixtures.js";

const clericBuild: BuildChoices = {
  class: "cleric",
  kit: "shieldbearer",
  abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 16, cha: 12 },
  skills: ["insight", "medicine"],
  expertise: [],
  name: "Sister Ana",
  appearance: "",
  backstory: "",
};

// Jamie plays the cleric (WIS 16, +3; Disciple of Life; two 1st-level slots); Mira (Alex) is hurt.
function party(miraHp = 4): CampaignState {
  const base = newCampaign();
  const cleric: CharacterSheet = { ...deriveSheet(clericBuild), id: "c-borin", ownerUserId: "u-jamie" };
  return {
    ...base,
    characters: { ...base.characters, "c-borin": cleric },
    heroStatus: { ...base.heroStatus, "c-mira": { hp: miraHp, resources: { spellSlots: {}, featureUses: {} } } },
  };
}

const cast = (_state: CampaignState, overrides: Partial<{ spellId: string; slotLevel: number; targetId: string; characterId: string }> = {}): CampaignCommand =>
  ({
    kind: "castHealingSpell",
    characterId: overrides.characterId ?? "c-borin",
    targetId: overrides.targetId ?? "c-mira",
    spellId: overrides.spellId ?? "spell:cure-wounds",
    slotLevel: overrides.slotLevel ?? 1,
  }) as never;

function settle(step: Step, seed = 1): Step {
  const pending = step.state.healingPending?.["c-borin"];
  const request = step.requests.find((candidate) => candidate.kind === "roll");
  if (pending === undefined || request?.kind !== "roll") throw new Error("no healing roll asked for");
  return run(step.state, system, { kind: "recordRoll", rollId: pending.rollId, result: performRoll(request.spec, new SeededRandomSource(seed)) });
}

describe("castHealingSpell", () => {
  it("asks for the spell's own dice and changes nothing until they land", () => {
    const state = party();
    const step = run(state, jamie, cast(state));
    const pending = step.state.healingPending?.["c-borin"];
    // Cure Wounds: 1d8 + WIS +3, plus Disciple of Life's 2 + the spell level.
    expect(pending).toMatchObject({ targetId: "c-mira", slotLevel: 1, expression: { modifier: 3 + 2 + 1, terms: [{ count: 1, sides: 8 }] } });
    expect(step.requests).toContainEqual({ kind: "roll", rollId: pending?.rollId, spec: { kind: "dice", expression: pending?.expression, critical: false } });
    expect(step.state.heroStatus["c-mira"]?.hp).toBe(4);
    expect(step.state.heroStatus["c-borin"]).toBeUndefined();
  });

  it("spends a slot and heals by the roll, and the table is told from the saved event", () => {
    const state = party();
    const step = settle(run(state, jamie, cast(state)));
    const record = step.events.find((event) => event.kind === "healingSettled");
    if (record?.kind !== "healingSettled") throw new Error("not settled");
    expect(record.healing.rolled).toBeGreaterThanOrEqual(1 + 6);
    expect(step.state.heroStatus["c-mira"]?.hp).toBe(Math.min(state.characters["c-mira"]?.maxHp ?? 0, 4 + record.healing.rolled));
    expect(step.state.heroStatus["c-borin"]?.resources.spellSlots[1]).toBe(1);
    expect(step.state.healingPending?.["c-borin"]).toBeUndefined();
    expect(step.state.healingCount).toBe(1);
    expect(step.requests).toContainEqual({ kind: "deliver", delivery: { kind: "healingSettled", healingId: record.healing.id } });
  });

  it("never heals past the target's maximum, and says how much it really did", () => {
    const state = party();
    const max = state.characters["c-mira"]?.maxHp ?? 0;
    const almost = { ...state, heroStatus: { ...state.heroStatus, "c-mira": { hp: max - 1, resources: { spellSlots: {}, featureUses: {} } } } };
    const step = settle(run(almost, jamie, cast(almost)));
    expect(step.state.heroStatus["c-mira"]?.hp).toBe(max);
    const record = step.events.find((event) => event.kind === "healingSettled");
    expect(record?.kind === "healingSettled" && record.healing.healed).toBe(1);
  });

  it("lets the caster heal themselves with the one slot", () => {
    const base = party();
    const state = { ...base, heroStatus: { ...base.heroStatus, "c-borin": { hp: 2, resources: { spellSlots: { 1: 2 }, featureUses: {} } } } };
    const step = settle(run(state, jamie, cast(state, { targetId: "c-borin" })));
    expect(step.state.heroStatus["c-borin"]?.hp).toBeGreaterThan(2);
    expect(step.state.heroStatus["c-borin"]?.resources.spellSlots[1]).toBe(1);
  });

  it("refuses what is not a healing spell, is not known, or has no slot", () => {
    const state = party();
    expect(reject(state, jamie, cast(state, { spellId: "spell:bless" }))).toEqual({ code: "notAHealingSpell" });
    expect(reject(state, jamie, cast(state, { spellId: "spell:sacred-flame", slotLevel: 0 }))).toEqual({ code: "notAHealingSpell" });
    expect(reject(state, jamie, cast(state, { spellId: "spell:fireball" }))).toEqual({ code: "unknownSpell" });
    expect(reject(state, jamie, cast(state, { slotLevel: 2 }))).toEqual({ code: "noSpellSlot", slotLevel: 2 });
    const spent = { ...state, heroStatus: { ...state.heroStatus, "c-borin": { hp: 9, resources: { spellSlots: { 1: 0 }, featureUses: {} } } } };
    expect(reject(spent, jamie, cast(spent))).toEqual({ code: "noSpellSlot", slotLevel: 1 });
  });

  it("refuses the wrong caster, an unknown or whole target, a fight, and a second cast waiting", () => {
    const state = party();
    expect(reject(state, alex, cast(state))).toEqual({ code: "notYourCharacter" });
    expect(reject(state, jamie, cast(state, { targetId: "c-nobody" }))).toEqual({ code: "invalidTarget" });
    const whole = party(state.characters["c-mira"]?.maxHp ?? 8);
    expect(reject(whole, jamie, cast(whole))).toEqual({ code: "nothingToHeal" });
    const waiting = run(state, jamie, cast(state));
    expect(reject(waiting.state, jamie, cast(waiting.state))).toEqual({ code: "healingAlreadyPending" });
  });

  it("refuses a result that does not belong to the request", () => {
    const step = run(party(), jamie, cast(party()));
    const pending = step.state.healingPending?.["c-borin"];
    const wrong = performRoll({ kind: "dice", expression: { terms: [{ count: 2, sides: 4 }], modifier: 0 }, critical: false }, new SeededRandomSource(1));
    expect(reject(step.state, system, { kind: "recordRoll", rollId: pending?.rollId ?? "", result: wrong })).toEqual({ code: "rollMismatch" });
  });
});
