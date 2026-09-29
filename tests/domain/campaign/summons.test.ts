import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { organizer, partyOfThree, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Conjured creatures: they join the fight on the caster's side, act on their own turns, and never count as heroes.

function withConjure(): CampaignState {
  const base = partyOfThree();
  const elspeth = base.characters["c-elspeth"];
  const casting = elspeth?.spellcasting;
  if (elspeth === undefined || casting === undefined || casting === null) throw new Error("elspeth");
  const slots = { ...casting.slots, 3: 1 };
  return { ...base, characters: { ...base.characters, "c-elspeth": { ...elspeth, spellcasting: { ...casting, spells: [...casting.spells, "spell:conjure-animals"] as typeof casting.spells, slots } } } };
}

describe("Conjure Animals", () => {
  it("brings two bears into the fight on the party's side, right after the caster", () => {
    const fight = new Fight(withConjure()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:conjure-animals", slotLevel: 3, targetIds: ["c-elspeth"] });
    const bears = Object.values(fight.encounter.combatants).filter((combatant) => combatant.id.startsWith("c-elspeth-brown-bear"));
    expect(bears).toHaveLength(2);
    expect(bears.every((bear) => bear.side === "party" && bear.hp === bear.maxHp)).toBe(true);
    const order = fight.encounter.order;
    expect(order[0]).toBe("c-elspeth");
    expect(new Set(order.slice(1, 3))).toEqual(new Set(bears.map((bear) => bear.id)));
    expect(fight.encounter.status).toBe("active");
  });

  it("plays the bears' turns on their own: they close in and fell the goblins, and the experience goes to the heroes", () => {
    const fight = new Fight(withConjure()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:conjure-animals", slotLevel: 3, targetIds: ["c-elspeth"] });
    // Each bear walks to a goblin and hits it (15) for plenty of damage.
    fight.rolls([15, 15, 15, 15, 15, 15], Array.from({ length: 12 }, () => 6)).run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    expect(fight.combatant("goblin-a").hp).toBe(0);
    expect(fight.combatant("goblin-b").hp).toBe(0);
    expect(fight.encounter.status).toBe("ended");
    const awarded = fight.events.filter((event) => event.kind === "experienceAwarded");
    expect(awarded).toHaveLength(1);
    expect(JSON.stringify(awarded[0])).not.toContain("brown-bear");
  });
});

describe("Thunderwave", () => {
  it("pushes a creature that fails its save into the next zone, out of reach", () => {
    const base = partyOfThree();
    const elspeth = base.characters["c-elspeth"];
    const casting = elspeth?.spellcasting;
    if (elspeth === undefined || casting === undefined || casting === null) throw new Error("elspeth");
    const state: CampaignState = { ...base, characters: { ...base.characters, "c-elspeth": { ...elspeth, spellcasting: { ...casting, spells: [...casting.spells, "spell:thunderwave"] as typeof casting.spells } } } };
    const spec = { ...skirmish, zones: [...skirmish.zones, { id: "yard", name: "Yard" }], edges: [{ from: "gate", to: "courtyard", feet: 10 }, { from: "courtyard", to: "yard", feet: 10 }] };
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec });
    fight.rolls([2, 20], [1, 1]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:thunderwave", slotLevel: 1, targetIds: ["goblin-a", "goblin-b"] });
    // The first goblin failed its save and is thrown back; the second held its ground.
    expect(fight.combatant("goblin-a").zoneId).toBe("yard");
    expect(fight.combatant("goblin-b").zoneId).toBe("courtyard");
  });
});
