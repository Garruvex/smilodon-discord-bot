import { describe, expect, it } from "vitest";

import { castableSlotLevels, concentrationDc, lowestSlot, slotUnavailable, spellMaxTargets, spellTargetProblem, type SpellParty } from "../../../src/domain/campaign/magic/spell-rules.js";
import type { SpellDefinition } from "../../../src/domain/campaign/rules/content-definitions.js";
import { ruleset } from "./campaign-fixtures.js";

const spell = (id: `spell:${string}`): SpellDefinition => {
  const definition = ruleset().content.get(id);
  if (definition.kind !== "spell") throw new Error(id);
  return definition;
};
const me: SpellParty = { id: "cleric", side: "party", zoneId: "gate" };
const ally: SpellParty = { id: "fighter", side: "party", zoneId: "gate" };
const farAlly: SpellParty = { id: "archer", side: "party", zoneId: "tower" };
const foe: SpellParty = { id: "goblin", side: "foes", zoneId: "courtyard" };

describe("spell slots", () => {
  it("has no slot for a cantrip and needs one of the spell's level or higher otherwise", () => {
    expect(slotUnavailable(spell("spell:sacred-flame"), {}, 0)).toBe(false);
    expect(slotUnavailable(spell("spell:sacred-flame"), { 1: 2 }, 1)).toBe(true);
    expect(slotUnavailable(spell("spell:bless"), { 1: 2 }, 1)).toBe(false);
    expect(slotUnavailable(spell("spell:bless"), { 1: 0 }, 1)).toBe(true);
    expect(slotUnavailable(spell("spell:bless"), { 1: 2 }, 0)).toBe(true);
  });

  it("lists the levels a spell can be cast at now, lowest first", () => {
    expect(castableSlotLevels(spell("spell:sacred-flame"), {})).toEqual([0]);
    expect(castableSlotLevels(spell("spell:bless"), { 1: 0, 2: 1, 3: 2 })).toEqual([2, 3]);
    expect(lowestSlot(spell("spell:bless"), { 1: 0, 2: 1 })).toBe(2);
    expect(lowestSlot(spell("spell:bless"), { 1: 0 })).toBeUndefined();
  });

  it("adds targets to the spells that gain them from a higher slot", () => {
    const bless = spell("spell:bless");
    expect(spellMaxTargets(bless, 1)).toBe(3);
    expect(spellMaxTargets(bless, 2)).toBe(4);
    expect(spellMaxTargets(spell("spell:sacred-flame"), 0)).toBe(1);
    expect(spellMaxTargets(spell("spell:shield"), 1)).toBe(1);
  });
});

describe("whom a spell may name", () => {
  it("keeps to the spell's relation: any creature, enemies only, or allies and self only", () => {
    const of = (relation: SpellDefinition["targeting"]["relation"]): SpellDefinition => ({ ...spell("spell:sacred-flame"), targeting: { relation, count: 1 } });
    for (const target of [foe, ally]) expect(spellTargetProblem(of("creature"), me, target, true, 5)).toBeNull();
    expect(spellTargetProblem(of("enemy"), me, foe, true, 5)).toBeNull();
    expect(spellTargetProblem(of("enemy"), me, ally, true, 5)).toBe("invalidTarget");
    expect(spellTargetProblem(of("ally-or-self"), me, ally, true, 5)).toBeNull();
    expect(spellTargetProblem(of("ally-or-self"), me, foe, true, 5)).toBe("invalidTarget");
  });

  it("refuses someone who is gone, or nobody", () => {
    expect(spellTargetProblem(spell("spell:sacred-flame"), me, foe, false, 40)).toBe("invalidTarget");
    expect(spellTargetProblem(spell("spell:sacred-flame"), me, undefined, true, null)).toBe("invalidTarget");
  });

  it("keeps to the spell's reach: feet, touch (same zone), or self", () => {
    expect(spellTargetProblem(spell("spell:sacred-flame"), me, foe, true, 60)).toBeNull();
    expect(spellTargetProblem(spell("spell:sacred-flame"), me, foe, true, 65)).toBe("outOfRange");
    expect(spellTargetProblem(spell("spell:sacred-flame"), me, foe, true, null)).toBe("outOfRange");
    expect(spellTargetProblem(spell("spell:cure-wounds"), me, ally, true, 5)).toBeNull();
    expect(spellTargetProblem(spell("spell:cure-wounds"), me, farAlly, true, 30)).toBe("outOfRange");
    expect(spellTargetProblem(spell("spell:shield"), me, me, true, 0)).toBeNull();
    expect(spellTargetProblem(spell("spell:shield"), me, ally, true, 5)).toBe("outOfRange");
  });
});

describe("keeping concentration", () => {
  it("asks for a save of 10, or half the damage when that is more", () => {
    expect(concentrationDc(1)).toBe(10);
    expect(concentrationDc(19)).toBe(10);
    expect(concentrationDc(22)).toBe(11);
    expect(concentrationDc(40)).toBe(20);
  });
});
