import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { organizer, partyOfThree, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// A sorcerer's Metamagic: sorcery points from Font of Magic, readied before a spell and used up by it.

function sorcerer(): CampaignState {
  const base = partyOfThree();
  const elspeth = base.characters["c-elspeth"];
  if (elspeth === undefined) throw new Error("elspeth");
  const features = [...elspeth.features, "feature:font-of-magic", "feature:quickened-spell", "feature:twinned-spell"] as typeof elspeth.features;
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
});
