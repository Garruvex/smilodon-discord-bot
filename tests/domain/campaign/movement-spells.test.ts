import { describe, expect, it } from "vitest";

import { alex, jamie, organizer, partyWithSpells, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Spells that change how far a creature moves, and a few buffs and controls the curated table now holds.

const spec = { ...skirmish, edges: [{ from: "gate", to: "courtyard", feet: 60 }] };

function start(spells: readonly `spell:${string}`[], slots: Readonly<Record<number, number>> = { 1: 2, 2: 1 }): Fight {
  return new Fight(partyWithSpells(spells, slots)).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec });
}

describe("Misty Step", () => {
  it("gives thirty feet of movement that provokes nothing, as a bonus action", () => {
    const fight = start(["spell:misty-step"]);
    const before = fight.combatant("c-elspeth").budget.movement;
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:misty-step", slotLevel: 2, targetIds: ["c-elspeth"] });
    const after = fight.combatant("c-elspeth");
    expect(after.budget.movement).toBe(before + 30);
    expect(after.budget.bonusAction).toBe(false);
    expect(after.effects.some((effect) => effect.modifiers.some((modifier) => modifier.kind === "avoidsOpportunityAttacks"))).toBe(true);
  });
});

describe("Longstrider", () => {
  it("adds ten feet of movement on every turn while it lasts", () => {
    const fight = start(["spell:longstrider"]);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:longstrider", slotLevel: 1, targetIds: ["c-elspeth"] });
    const speed = fight.combatant("c-elspeth").speed;
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.rolls(Array.from({ length: 12 }, () => 1), Array.from({ length: 12 }, () => 1)).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    // Round two: Elspeth's turn begins with the extra ten feet.
    const turns = fight.events.filter((event) => event.kind === "turnStarted" && event.combatantId === "c-elspeth");
    expect(turns.at(-1)).toMatchObject({ round: 2, movement: speed + 10 });
    expect(fight.combatant("c-elspeth").budget.movement).toBe(speed + 10);
  });
});

describe("Web", () => {
  it("restrains creatures that fail their Dexterity save", () => {
    const fight = start(["spell:web"], { 1: 2, 2: 1 });
    fight.rolls([2, 20]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:web", slotLevel: 2, targetIds: ["goblin-a", "goblin-b"] });
    expect(fight.combatant("goblin-a").effects.map((effect) => effect.definition)).toContain("condition:restrained");
    expect(fight.combatant("goblin-b").effects.map((effect) => effect.definition)).not.toContain("condition:restrained");
  });
});
