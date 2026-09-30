import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import type { Combatant } from "../../../src/domain/campaign/combat/combat-state.js";
import { alex, jamie, organizer, partyWithSpells, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Conjured creatures: they join the fight on the caster's side, act on their own turns, and never count as heroes.

function withConjure(): CampaignState {
  return partyWithSpells(["spell:conjure-animals"], { 3: 1 });
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

describe("a summon held by concentration", () => {
  it("vanishes when the caster's concentration ends", () => {
    const fight = new Fight(withConjure()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:conjure-animals", slotLevel: 3, targetIds: ["c-elspeth"] });
    const bears = (): Combatant[] => Object.values(fight.encounter.combatants).filter((combatant) => combatant.id.startsWith("c-elspeth-brown-bear"));
    expect(bears().every((bear) => bear.hp > 0 && bear.boundTo !== undefined)).toBe(true);
    // Everything misses through the round; on her next turn she takes up another concentration spell.
    fight.rolls(Array.from({ length: 12 }, () => 1), Array.from({ length: 12 }, () => 1)).run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.rolls(Array.from({ length: 12 }, () => 1), Array.from({ length: 12 }, () => 1)).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:bless", slotLevel: 1, targetIds: ["c-elspeth"] });
    expect(bears().every((bear) => bear.hp === 0 && bear.condition === "dead")).toBe(true);
  });
});

describe("Spiritual Weapon", () => {
  it("calls a spectral weapon that keeps attacking for the caster without concentration", () => {
    const state = partyWithSpells(["spell:spiritual-weapon"], { 2: 1 });
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:spiritual-weapon", slotLevel: 2, targetIds: ["c-elspeth"] });
    expect(fight.combatant("c-elspeth").concentration).toBeNull();
    const weapon = Object.values(fight.encounter.combatants).find((combatant) => combatant.id.startsWith("c-elspeth-spiritual-weapon"));
    expect(weapon).toMatchObject({ side: "party" });
    // On its turn it walks up and strikes: 1d8 + 3 force.
    fight.rolls([15], [4]).run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    expect(fight.events).toContainEqual(expect.objectContaining({ kind: "combatantHpChanged", combatantId: "goblin-a", change: -7 }));
  });
});

describe("The other conjuring spells", () => {
  it("Giant Insect grows three centipedes on the party's side and Animate Objects six flying swords", () => {
    const summoned = (spell: `spell:${string}`, slot: number, prefix: string): number => {
      const fight = new Fight(partyWithSpells([spell], { [slot]: 1 })).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
      fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: spell, slotLevel: slot, targetIds: ["c-elspeth"] });
      return Object.values(fight.encounter.combatants).filter((combatant) => combatant.id.startsWith(prefix) && combatant.side === "party").length;
    };
    expect(summoned("spell:giant-insect", 4, "c-elspeth-giant-centipede")).toBe(3);
    expect(summoned("spell:animate-objects", 5, "c-elspeth-flying-sword")).toBe(6);
  });
});

describe("Thunderwave", () => {
  it("pushes a creature that fails its save into the next zone, out of reach", () => {
    const state = partyWithSpells(["spell:thunderwave"]);
    const spec = { ...skirmish, zones: [...skirmish.zones, { id: "yard", name: "Yard" }], edges: [{ from: "gate", to: "courtyard", feet: 10 }, { from: "courtyard", to: "yard", feet: 10 }] };
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec });
    fight.rolls([2, 20], [1, 1]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:thunderwave", slotLevel: 1, targetIds: ["goblin-a", "goblin-b"] });
    // The first goblin failed its save and is thrown back; the second held its ground.
    expect(fight.combatant("goblin-a").zoneId).toBe("yard");
    expect(fight.combatant("goblin-b").zoneId).toBe("courtyard");
  });
});
