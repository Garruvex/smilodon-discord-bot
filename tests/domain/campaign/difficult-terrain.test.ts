import { describe, expect, it } from "vitest";

import { organizer, partyOfThree, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";
import { shortestPath, stepCost } from "../../../src/domain/campaign/combat/positioning.js";

// Difficult terrain: every foot of the way into the zone costs two.

const rough = { ...skirmish, zones: [{ id: "gate", name: "Gate" }, { id: "courtyard", name: "Courtyard", difficult: true }] };

describe("difficult terrain", () => {
  it("doubles what a walker pays to enter the zone, and nothing else", () => {
    expect(stepCost(rough.edges, rough.zones, "gate", "courtyard")).toBe(40);
    expect(stepCost(rough.edges, rough.zones, "courtyard", "gate")).toBe(20);
    expect(shortestPath(rough.edges, "gate", "courtyard", rough.zones)?.feet).toBe(40);
    // Range measures plain distance.
    expect(shortestPath(rough.edges, "gate", "courtyard")?.feet).toBe(20);
  });

  it("takes twice the movement from a hero who steps into it, and refuses a step they cannot afford", () => {
    const fight = new Fight(partyOfThree()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: rough });
    // Elspeth has 30 feet of movement; the courtyard costs 40.
    expect(fight.reject(sam, { kind: "combatMove", combatantId: "c-elspeth", zoneId: "courtyard" })).toMatchObject({ code: "notEnoughMovement", needed: 40 });
    const plain = new Fight(partyOfThree()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    plain.run(sam, { kind: "combatMove", combatantId: "c-elspeth", zoneId: "courtyard" });
    expect(plain.combatant("c-elspeth").budget.movement).toBe(10);
  });
});
