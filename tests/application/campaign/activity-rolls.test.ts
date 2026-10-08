import { describe, expect, it } from "vitest";

import { buildActivityRolls } from "../../../src/application/campaign/views/activity-rolls.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { organizer, partyWithSpells, sam } from "../../domain/campaign/campaign-fixtures.js";
import { Fight, skirmish } from "../../domain/campaign/combat-fixtures.js";

// Every kind of roll the hero makes comes out in one shape, so the page shows them all the same way.
describe("a hero's rolls in the Activity", () => {
  const cast = (): Fight => {
    const fight = new Fight(partyWithSpells(["spell:fire-bolt"], { 1: 2 })).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, partyZoneId: "courtyard" } });
    return fight.rolls([15], [4]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:fire-bolt", slotLevel: 0, targetIds: ["goblin-a"] });
  };

  it("lists initiative, then the attack and its damage, each with its own id and what it was made with", () => {
    const fight = cast();
    const rolls = buildActivityRolls(fight.state, fight.events, "c-elspeth", enSrd51Glossary);
    expect(rolls.map((roll) => roll.kind)).toEqual(["initiative", "attack", "damage"]);
    expect(rolls[1]).toMatchObject({ kind: "attack", using: "Fire Bolt", natural: 15, success: true, dc: null });
    expect(rolls[2]).toMatchObject({ kind: "damage", using: "Fire Bolt", total: 4, natural: null, success: null });
    expect(new Set(rolls.map((roll) => roll.id)).size).toBe(3);
  });

  it("does not list what other heroes rolled", () => {
    const fight = cast();
    expect(buildActivityRolls(fight.state, fight.events, "c-mira", enSrd51Glossary).map((roll) => roll.kind)).toEqual(["initiative"]);
  });
});
