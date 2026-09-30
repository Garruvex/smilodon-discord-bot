import { describe, expect, it } from "vitest";

import { deriveSheet, type BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import type { CharacterSheet } from "../../../src/domain/campaign/character/character-sheet.js";
import { invocationSlots } from "../../../src/domain/campaign/character/warlock-choices.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, newCampaign, organizer, reject, run } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// A warlock's Eldritch Invocations and Pact Boon: chosen, capped by level, and swapped between fights.

const build: BuildChoices = {
  class: "warlock",
  kit: "fiendpact",
  abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 10, cha: 16 },
  skills: ["deception", "intimidation"],
  expertise: [],
  name: "Vex",
  appearance: "",
  backstory: "",
};

function withWarlock(level: number): CampaignState {
  const base = newCampaign();
  const sheet: CharacterSheet = { ...deriveSheet(build), id: "c-mira", ownerUserId: "u-alex", level, classLevels: { warlock: level } };
  return { ...base, characters: { ...base.characters, "c-mira": sheet } };
}

const choose = (extra: { invocations?: readonly string[]; pactBoon?: string }) => ({ kind: "chooseWarlockOptions", characterId: "c-mira", ...extra }) as const;

describe("Eldritch Invocations and Pact Boons", () => {
  it("counts the invocations a level allows", () => {
    expect([1, 2, 4, 5, 7, 9, 12, 15, 18, 20].map(invocationSlots)).toEqual([0, 2, 2, 3, 4, 5, 6, 7, 8, 8]);
  });

  it("swaps the held invocations for the chosen ones, no more than the level allows", () => {
    const state = withWarlock(2);
    const step = run(state, alex, choose({ invocations: ["feature:repelling-blast", "feature:devils-sight"] }));
    const features = step.state.characters["c-mira"]?.features ?? [];
    expect(features).toContain("feature:repelling-blast");
    expect(features).toContain("feature:devils-sight");
    expect(features).not.toContain("feature:agonizing-blast");
    expect(reject(state, alex, choose({ invocations: ["feature:repelling-blast", "feature:devils-sight", "feature:eldritch-sight"] }))).toEqual({ code: "unknownFeature" });
    expect(reject(state, alex, choose({ invocations: ["feature:rage"] }))).toEqual({ code: "unknownFeature" });
  });

  it("gives the Pact Boon from the third level, one at a time", () => {
    expect(reject(withWarlock(2), alex, choose({ pactBoon: "feature:pact-of-the-tome" }))).toEqual({ code: "unknownFeature" });
    const once = run(withWarlock(3), alex, choose({ pactBoon: "feature:pact-of-the-tome" })).state;
    const twice = run(once, alex, choose({ pactBoon: "feature:pact-of-the-chain" })).state;
    const features = twice.characters["c-mira"]?.features ?? [];
    expect(features).toContain("feature:pact-of-the-chain");
    expect(features).not.toContain("feature:pact-of-the-tome");
  });

  it("is the owner's or the organizer's to change, and not in a fight", () => {
    const state = withWarlock(2);
    expect(reject(state, { kind: "user", userId: "u-jamie" }, choose({ invocations: [] }))).toEqual({ code: "notYourCharacter" });
    run(state, organizer, choose({ invocations: [] }));
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    expect(fight.reject(alex, choose({ invocations: [] }))).toEqual({ code: "inCombat" });
  });

  it("Pact of the Chain lets the warlock call a familiar with the ritual command", () => {
    const state = run(withWarlock(3), alex, choose({ pactBoon: "feature:pact-of-the-chain" })).state;
    const step = run(state, alex, { kind: "castRitualSpell", characterId: "c-mira", spellId: "spell:find-familiar" });
    expect(Object.values(step.state.companions?.members ?? {})).toEqual([expect.objectContaining({ monsterId: "monster:owl", ownerId: "c-mira" })]);
  });

  it("Pact of the Tome puts three cantrips in reach in a fight, and Repelling Blast throws the target away", () => {
    const chosen = run(run(withWarlock(3), alex, choose({ pactBoon: "feature:pact-of-the-tome" })).state, alex, choose({ invocations: ["feature:repelling-blast"] })).state;
    const fight = new Fight(chosen).rolls([20, 4, 3, 2]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, partyZoneId: "courtyard", edges: [{ from: "gate", to: "courtyard", feet: 10 }] } });
    expect(fight.combatant("c-mira").spellcasting?.spells).toEqual(expect.arrayContaining(["spell:guidance", "spell:sacred-flame", "spell:shocking-grasp", "spell:eldritch-blast"]));
    fight.rolls([15], [4, 4]).run(alex, { kind: "combatCast", combatantId: "c-mira", spellId: "spell:eldritch-blast", slotLevel: 0, targetIds: ["goblin-a"] });
    expect(fight.combatant("goblin-a").zoneId).toBe("gate");
  });
});
