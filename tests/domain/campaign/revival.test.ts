import { describe, expect, it } from "vitest";

import { partyWithSpells, reject, run, sam } from "./campaign-fixtures.js";

// Revivify and the spells above it bring a fallen hero back between fights.

function withFallenMira(spells: readonly `spell:${string}`[], slots: Readonly<Record<number, number>>): ReturnType<typeof partyWithSpells> {
  const base = partyWithSpells(spells, slots);
  return { ...base, heroStatus: { ...base.heroStatus, "c-mira": { hp: 0, dead: true, resources: { spellSlots: {}, featureUses: {} } } } };
}

const cast = (spellId: `spell:${string}`, slotLevel: number) => ({ kind: "castReviveSpell", characterId: "c-elspeth", targetId: "c-mira", spellId, slotLevel }) as const;

describe("bringing back a fallen hero", () => {
  it("Revivify raises the hero with 1 hit point and spends the slot", () => {
    const state = withFallenMira(["spell:revivify"], { 3: 1 });
    const step = run(state, sam, cast("spell:revivify", 3));
    expect(step.state.heroStatus["c-mira"]).toMatchObject({ hp: 1 });
    expect(step.state.heroStatus["c-mira"]?.dead).toBeUndefined();
    expect(step.state.heroStatus["c-elspeth"]?.resources.spellSlots[3]).toBe(0);
  });

  it("Resurrection gives back all the hit points", () => {
    const state = withFallenMira(["spell:resurrection"], { 7: 1 });
    const step = run(state, sam, cast("spell:resurrection", 7));
    expect(step.state.heroStatus["c-mira"]?.hp).toBe(state.characters["c-mira"]?.maxHp);
  });

  it("refuses a hero who has not fallen, a spell that does not raise the dead, and a missing slot", () => {
    const alive = partyWithSpells(["spell:revivify"], { 3: 1 });
    expect(reject(alive, sam, cast("spell:revivify", 3))).toEqual({ code: "invalidTarget" });
    const state = withFallenMira(["spell:revivify", "spell:bless"], { 3: 1 });
    expect(reject(state, sam, { ...cast("spell:bless", 1) })).toEqual({ code: "unknownSpell" });
    expect(reject(withFallenMira(["spell:revivify"], { 3: 0 }), sam, cast("spell:revivify", 3))).toEqual({ code: "noSpellSlot", slotLevel: 3 });
  });
});
