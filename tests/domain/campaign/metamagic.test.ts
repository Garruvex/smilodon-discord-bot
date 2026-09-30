import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { organizer, partyOfThree, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// A sorcerer's Metamagic: sorcery points from Font of Magic, readied before a spell and used up by it.

function sorcerer(): CampaignState {
  const base = partyOfThree();
  const elspeth = base.characters["c-elspeth"];
  if (elspeth === undefined) throw new Error("elspeth");
  const features = [...elspeth.features, "feature:font-of-magic", "feature:quickened-spell", "feature:twinned-spell", "feature:heightened-spell", "feature:empowered-spell", "feature:extended-spell", "feature:subtle-spell", "feature:create-slot-2", "feature:slot-to-points-1"] as typeof elspeth.features;
  // Level 4 (sorcery points equal the level).
  return { ...base, characters: { ...base.characters, "c-elspeth": { ...elspeth, features, level: 4 } } };
}

// Elspeth acts first (initiative 20).
const started = (): Fight => new Fight(sorcerer()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });

describe("Metamagic", () => {
  it("Quickened Spell turns an action spell into a bonus action, and costs two sorcery points", () => {
    const fight = started();
    fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:quickened-spell" });
    expect(fight.combatant("c-elspeth").resources.featureUses["feature:font-of-magic"]).toBe(2);
    fight.rolls([3], [4]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
    expect(fight.combatant("c-elspeth").budget.bonusAction).toBe(false);
    expect(fight.combatant("c-elspeth").budget.action).toBe(true);
    // The readied option was used up by the casting.
    expect(fight.combatant("c-elspeth").effects.some((effect) => effect.modifiers.some((modifier) => modifier.kind === "metamagic"))).toBe(false);
  });

  it("Twinned Spell lets a one-target spell name a second creature", () => {
    const fight = started();
    fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:twinned-spell" });
    fight.rolls([3, 3], [4, 4]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a", "goblin-b"] });
    expect(fight.combatant("goblin-a").hp).toBeLessThan(7);
    expect(fight.combatant("goblin-b").hp).toBeLessThan(7);
  });

  it("refuses a Metamagic option when too few sorcery points are left", () => {
    const fight = started();
    fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:quickened-spell" });
    fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:twinned-spell" });
    expect(fight.combatant("c-elspeth").resources.featureUses["feature:font-of-magic"]).toBe(0);
    expect(() => fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:twinned-spell" })).toThrow();
  });

  const save = (feature: string | null): { readonly mode: string; readonly modifier: number } => {
    const fight = started();
    if (feature !== null) fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: feature as "feature:heightened-spell" });
    fight.rolls([3], [4]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
    const declared = fight.events.filter((event) => event.kind === "resolutionDeclared").at(-1);
    const spec = Object.values(declared?.resolution.checks ?? {})[0]?.spec;
    return { mode: spec?.mode ?? "?", modifier: spec?.modifier ?? 0 };
  };

  it("Heightened Spell gives the first target disadvantage on its save", () => {
    expect(save(null).mode).toBe("normal");
    expect(save("feature:heightened-spell").mode).toBe("disadvantage");
  });

  it("Empowered Spell adds the spellcasting modifier to a damage roll", () => {
    const damage = (feature: string | null): number => {
      const fight = started();
      if (feature !== null) fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: feature as "feature:empowered-spell" });
      fight.rolls([3], [4]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
      return 7 - fight.combatant("goblin-a").hp;
    };
    expect(damage("feature:empowered-spell")).toBe(damage(null) + 3);
  });

  it("Extended Spell doubles a timed effect", () => {
    const rounds = (feature: string | null): number | undefined => {
      const fight = started();
      if (feature !== null) fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: feature as "feature:extended-spell" });
      fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:bless", slotLevel: 1, targetIds: ["c-elspeth"] });
      return fight.combatant("c-elspeth").effects[0]?.clock?.untilRound;
    };
    expect((rounds("feature:extended-spell") ?? 0) - 1).toBe(((rounds(null) ?? 0) - 1) * 2);
  });

  it("Flexible Casting turns three sorcery points into a second-level slot", () => {
    const fight = started();
    const before = fight.combatant("c-elspeth").resources.spellSlots[2] ?? 0;
    fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:create-slot-2" });
    expect(fight.combatant("c-elspeth").resources.spellSlots[2]).toBe(before + 1);
    expect(fight.combatant("c-elspeth").resources.featureUses["feature:font-of-magic"]).toBe(1);
    expect(fight.combatant("c-elspeth").budget.bonusAction).toBe(false);
  });

  it("turns a spell slot back into sorcery points, and only while a slot is held and the points have room", () => {
    const fight = started();
    const convert = { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:slot-to-points-1" } as const;
    // The pool is full at the start, so there is nowhere for the points to go.
    expect(fight.reject(sam, convert)).toEqual({ code: "notUsable" });
    fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:quickened-spell" });
    const slots = fight.combatant("c-elspeth").resources.spellSlots[1] ?? 0;
    fight.run(sam, convert);
    expect(fight.combatant("c-elspeth").resources.spellSlots[1]).toBe(slots - 1);
    // One point came back.
    expect(fight.combatant("c-elspeth").resources.featureUses["feature:font-of-magic"]).toBe(3);
  });
});
