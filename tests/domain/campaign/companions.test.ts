import { describe, expect, it } from "vitest";

import { afterFight, afterRest, emptyRoster, withSummoned, type Companion } from "../../../src/domain/campaign/companions/companion-roster.js";
import { organizer, partyWithSpells, reject, run, sam, alex } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Creatures a hero brings along between fights: cast outside combat, kept by the campaign, and joined to the next fight.

const owl = (over: Partial<Companion> = {}): Companion => ({ id: "companion:1", ownerId: "c-elspeth", monsterId: "monster:owl", spellId: "spell:find-familiar", hp: null, lasts: "dismissed", ...over });

describe("Find Familiar", () => {
  const state = partyWithSpells(["spell:find-familiar"], { 1: 1 });
  const cast = { kind: "summonCompanion", characterId: "c-elspeth", spellId: "spell:find-familiar", slotLevel: 1 } as const;

  it("costs no slot, being a ritual, and leaves an owl waiting in the campaign", () => {
    const step = run(state, sam, cast);
    expect(step.state.companions?.members["companion:1"]).toMatchObject({ monsterId: "monster:owl", ownerId: "c-elspeth", lasts: "dismissed" });
    expect(step.state.heroStatus["c-elspeth"]?.resources.spellSlots[1] ?? 1).toBe(1);
    expect(step.requests).toContainEqual({ kind: "narrateUtilityCast", castId: "cast:1" });
  });

  it("is also what the ordinary ritual command does with it, so the spell menu needs no second entry", () => {
    const step = run(state, sam, { kind: "castRitualSpell", characterId: "c-elspeth", spellId: "spell:find-familiar" });
    expect(Object.keys(step.state.companions?.members ?? {})).toEqual(["companion:1"]);
    expect(run(partyWithSpells(["spell:augury"], {}), sam, { kind: "castRitualSpell", characterId: "c-elspeth", spellId: "spell:augury" }).state.companions).toBeUndefined();
  });

  it("is replaced by a second casting instead of piling up", () => {
    const twice = run(run(state, sam, cast).state, sam, cast).state;
    expect(Object.keys(twice.companions?.members ?? {})).toEqual(["companion:2"]);
  });

  it("joins the next fight on the party's side and rolls its own initiative", () => {
    const fight = new Fight(run(state, sam, cast).state).rolls([5, 4, 20, 3, 2, 9]).run(organizer, { kind: "startEncounter", spec: skirmish });
    const familiar = Object.values(fight.encounter.combatants).find((combatant) => combatant.companionId === "companion:1");
    expect(familiar).toMatchObject({ side: "party", hp: 1 });
    expect(fight.encounter.order).toContain(familiar?.id);
  });

  it("can be dismissed by its owner and nobody else", () => {
    const held = run(state, sam, cast).state;
    expect(reject(held, alex, { kind: "dismissCompanion", characterId: "c-mira", companionId: "companion:1" })).toEqual({ code: "invalidTarget" });
    expect(run(held, sam, { kind: "dismissCompanion", characterId: "c-elspeth", companionId: "companion:1" }).state.companions?.members).toEqual({});
  });

  it("cannot be cast in a fight", () => {
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    expect(reject(fight.state, sam, cast)).toEqual({ code: "inCombat" });
  });
});

describe("Animate Dead outside a fight", () => {
  const state = partyWithSpells(["spell:animate-dead"], { 3: 1 });
  const cast = { kind: "summonCompanion", characterId: "c-elspeth", spellId: "spell:animate-dead", slotLevel: 3 } as const;

  it("spends the slot and raises a skeleton that lasts through the next fight only", () => {
    const step = run(state, sam, cast);
    expect(step.state.heroStatus["c-elspeth"]?.resources.spellSlots[3]).toBe(0);
    expect(Object.values(step.state.companions?.members ?? {})).toEqual([expect.objectContaining({ monsterId: "monster:skeleton", lasts: "nextFight" })]);
  });

  it("is refused without a slot, or with a slot too low", () => {
    expect(reject(partyWithSpells(["spell:animate-dead"], { 3: 0 }), sam, cast)).toEqual({ code: "noSpellSlot", slotLevel: 3 });
    expect(reject(partyWithSpells(["spell:animate-dead"], { 2: 1 }), sam, { ...cast, slotLevel: 2 })).toEqual({ code: "noSpellSlot", slotLevel: 2 });
  });

  it("refuses a spell that is not a conjuring of this kind", () => {
    expect(reject(partyWithSpells(["spell:bless"], { 1: 1 }), sam, { ...cast, spellId: "spell:bless", slotLevel: 1 })).toEqual({ code: "unknownSpell" });
  });
});

describe("the roster", () => {
  const roster = withSummoned(emptyRoster, [owl(), owl({ id: "companion:2", monsterId: "monster:skeleton", lasts: "nextFight" })], []);

  it("keeps a survivor's wounds, drops the fallen and a conjuring that ran its minute", () => {
    const after = afterFight(roster, [{ companionId: "companion:1", hp: 1, condition: "active" }, { companionId: "companion:2", hp: 5, condition: "active" }]);
    expect(after?.members).toEqual({ "companion:1": owl({ hp: 1 }) });
    expect(afterFight(roster, [{ companionId: "companion:1", hp: 0, condition: "dead" }])?.members["companion:1"]).toBeUndefined();
  });

  it("leaves a companion that took no part in the fight as it was", () => {
    expect(afterFight(roster, [])?.members["companion:2"]).toBeDefined();
  });

  it("heals what stays and ends the conjurings on a long rest, and changes nothing on a short one", () => {
    const hurt = withSummoned(roster, [owl({ hp: 1 })], ["companion:1"]);
    expect(afterRest(hurt, "short")).toBe(hurt);
    expect(afterRest(hurt, "long")?.members).toEqual({ "companion:1": owl({ hp: null }) });
  });
});
