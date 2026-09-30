import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, organizer, partyWithSpells, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

function withFeatures(state: CampaignState, heroId: string, features: readonly string[]): CampaignState {
  const sheet = state.characters[heroId];
  if (sheet === undefined) throw new Error(heroId);
  return { ...state, characters: { ...state.characters, [heroId]: { ...sheet, features: [...sheet.features, ...features] as typeof sheet.features } } };
}

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

describe("Escaping and curing", () => {
  const grappledElspeth = (extra: readonly `spell:${string}`[] = []): Fight => {
    const fight = new Fight(withFeatures(partyWithSpells(extra, { 2: 1 }), "c-elspeth", ["feature:escape-grapple"])).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec });
    const encounter = fight.encounter;
    const elspeth = encounter.combatants["c-elspeth"];
    if (elspeth === undefined) throw new Error("elspeth");
    const held = { id: "held", definition: "condition:grappled" as const, sourceId: "goblin-a", conditions: [], modifiers: [{ kind: "speedZero" as const }], triggers: [], clock: null, concentrationId: null, stacking: "coexist" as const };
    fight.state = { ...fight.state, encounter: { ...encounter, combatants: { ...encounter.combatants, "c-elspeth": { ...elspeth, effects: [...elspeth.effects, held] } } } };
    return fight;
  };

  it("a grappled hero breaks free with an action", () => {
    const fight = grappledElspeth();
    expect(fight.combatant("c-elspeth").effects.map((effect) => effect.definition)).toContain("condition:grappled");
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:escape-grapple", slotLevel: 0, targetIds: ["c-elspeth"] });
    expect(fight.combatant("c-elspeth").effects.map((effect) => effect.definition)).not.toContain("condition:grappled");
    expect(fight.combatant("c-elspeth").budget.action).toBe(false);
  });

  it("Lesser Restoration ends a poisoning", () => {
    const fight = grappledElspeth(["spell:lesser-restoration"]);
    const elspeth = fight.combatant("c-elspeth");
    const poisoned = { ...elspeth.effects[0]!, id: "sick", definition: "condition:poisoned" as const };
    fight.state = { ...fight.state, encounter: { ...fight.encounter, combatants: { ...fight.encounter.combatants, "c-elspeth": { ...elspeth, effects: [...elspeth.effects, poisoned] } } } };
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:lesser-restoration", slotLevel: 2, targetIds: ["c-elspeth"] });
    expect(fight.combatant("c-elspeth").effects.map((effect) => effect.definition)).toEqual(["condition:grappled"]);
  });
});

describe("Hunter's Mark", () => {
  it("adds a d6 to the caster's weapon hits on the marked creature", () => {
    const shoot = (mark: boolean): number => {
      const fight = new Fight(partyWithSpells(["spell:hunters-mark"], { 1: 2 })).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: { ...spec, partyZoneId: "courtyard" } });
      if (mark) fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:hunters-mark", slotLevel: 1, targetIds: ["goblin-a"] });
      // Elspeth closes in and swings her mace at the mark.
      fight.run(sam, { kind: "combatEngage", combatantId: "c-elspeth", targetId: "goblin-a" });
      fight.rolls([15], [1, 4]).run(sam, { kind: "combatAttack", combatantId: "c-elspeth", targetId: "goblin-a", weapon: "item:mace" });
      return 7 - fight.combatant("goblin-a").hp;
    };
    expect(shoot(true)).toBe(shoot(false) + 4);
  });
});

describe("Staffs", () => {
  it("spend charges from one shared pool, each spell at its own price", () => {
    const base = partyWithSpells([]);
    const hero = base.characters["c-borin"];
    if (hero === undefined) throw new Error("borin");
    const state: CampaignState = { ...base, characters: { ...base.characters, "c-borin": { ...hero, equipment: [...hero.equipment, "item:staff-of-fire" as const] } } };
    const fight = new Fight(state).rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, edges: [{ from: "gate", to: "courtyard", feet: 10 }] } });
    fight.rolls([3, 3], Array.from({ length: 8 }, () => 1)).run(jamie, { kind: "combatCast", combatantId: "c-borin", spellId: "spell:fireball", slotLevel: 3, targetIds: ["goblin-a", "goblin-b"] });
    // Fireball costs three of the ten charges.
    expect(fight.combatant("c-borin").resources.featureUses["pool:staff-of-fire"]).toBe(7);
    expect(fight.combatant("c-borin").spellcasting?.pools?.["spell:burning-hands"]).toEqual({ key: "pool:staff-of-fire", cost: 1 });
  });
});

describe("Spirit Guardians", () => {
  it("hurts each creature it names as its turn starts", () => {
    const fight = new Fight(partyWithSpells(["spell:spirit-guardians"], { 3: 1 })).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: { ...spec, edges: [{ from: "gate", to: "courtyard", feet: 10 }] } });
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:spirit-guardians", slotLevel: 3, targetIds: ["goblin-a"] });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.rolls(Array.from({ length: 6 }, () => 1), [2, 3, 1, 1, 1, 1, 1, 1]).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    // Two d8 as goblin A's turn begins (2 and 3), before it acts.
    expect(fight.combatant("goblin-a").hp).toBe(2);
    expect(fight.combatant("goblin-b").hp).toBe(7);
  });
});
