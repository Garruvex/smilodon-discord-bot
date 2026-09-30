import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { jamie, organizer, partyOfThree, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Late class features that ride on the spell and feature machinery: Dragon Wings, Draconic Presence, Spell Mastery and Signature Spells.

function elspeth(features: readonly string[], featureUses: Readonly<Record<string, number>> = {}): Fight {
  const base = partyOfThree();
  const sheet = base.characters["c-elspeth"];
  if (sheet === undefined) throw new Error("elspeth");
  const state: CampaignState = {
    ...base,
    characters: { ...base.characters, "c-elspeth": { ...sheet, level: 18, features: [...sheet.features, ...features] as typeof sheet.features } },
    heroStatus: { ...base.heroStatus, "c-elspeth": { hp: sheet.maxHp, resources: { spellSlots: {}, featureUses } } },
  };
  return new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
}

describe("Dragon Wings", () => {
  it("lift the sorcerer off the ground for as long as they like", () => {
    const fight = elspeth(["feature:dragon-wings"], { "feature:dragon-wings": 99 });
    fight.run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:dragon-wings" });
    const flying = fight.combatant("c-elspeth").effects.some((effect) => effect.modifiers.some((modifier) => modifier.kind === "flying"));
    expect(flying).toBe(true);
    expect(fight.combatant("c-elspeth").budget.bonusAction).toBe(false);
  });
});

describe("Draconic Presence", () => {
  it("costs five sorcery points and frightens the foes that fail their saves", () => {
    const fight = elspeth(["feature:draconic-presence"], { "feature:font-of-magic": 6 });
    fight.rolls([2, 2]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:draconic-presence", slotLevel: 0, targetIds: ["goblin-a", "goblin-b"] });
    expect(fight.combatant("c-elspeth").resources.featureUses["feature:font-of-magic"]).toBe(1);
    for (const goblin of ["goblin-a", "goblin-b"]) expect(fight.combatant(goblin).effects.some((effect) => effect.conditions.includes("condition:frightened"))).toBe(true);
  });

  it("is refused with fewer than five points left", () => {
    const fight = elspeth(["feature:draconic-presence"], { "feature:font-of-magic": 4 });
    expect(fight.reject(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:draconic-presence", slotLevel: 0, targetIds: ["goblin-a"] })).toEqual({ code: "noUsesLeft" });
  });
});

describe("Spell Mastery and Signature Spells", () => {
  it("cast their spells without a slot: Magic Missile at will, Fireball once until a short rest", () => {
    const mastery = elspeth(["feature:spell-mastery"]);
    mastery.rolls([], [1, 1, 1]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:magic-missile", slotLevel: 1, targetIds: ["goblin-a"] });
    expect(mastery.events.some((event) => event.kind === "resolutionDeclared" && event.resolution.actorId === "c-elspeth")).toBe(true);

    const signature = elspeth(["feature:signature-spells"]);
    signature.rolls([2, 2], Array.from({ length: 8 }, () => 1)).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:fireball", slotLevel: 3, targetIds: ["goblin-a"] });
    expect(signature.combatant("c-elspeth").resources.featureUses["innate:spell:fireball"]).toBe(0);
  });
});

describe("Quivering Palm", () => {
  const ogre = { monsterId: "monster:ogre", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null } as const;

  function palm(): Fight {
    const base = partyOfThree();
    const sheet = base.characters["c-borin"];
    if (sheet === undefined) throw new Error("borin");
    const state: CampaignState = {
      ...base,
      characters: { ...base.characters, "c-borin": { ...sheet, features: [...sheet.features, "feature:quivering-palm"] as typeof sheet.features } },
      heroStatus: { ...base.heroStatus, "c-borin": { hp: sheet.maxHp, resources: { spellSlots: {}, featureUses: { "feature:ki": 5 } } } },
    };
    const fight = new Fight(state).rolls([5, 20, 4, 3]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, partyZoneId: "courtyard", monsters: [ogre] } });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "ogre" });
    return fight.run(jamie, { kind: "combatUseFeature", combatantId: "c-borin", featureId: "feature:quivering-palm" });
  }
  const strike = (fight: Fight, save: number, rolled: number): Fight =>
    fight.rolls([15, save], [1, ...Array.from({ length: 10 }, () => rolled)]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "ogre", weapon: "item:longsword" });

  it("drops a creature that fails its Constitution save to 0 hit points, at three ki", () => {
    const fight = strike(palm(), 2, 1);
    expect(fight.combatant("ogre").condition).toBe("dead");
    expect(fight.combatant("c-borin").resources.featureUses["feature:ki"]).toBe(2);
  });

  it("hurts one that passes the save for 10d10 necrotic damage, and no more", () => {
    const fight = strike(palm(), 20, 2);
    const ogreNow = fight.combatant("ogre");
    // The sword does 1 die and the palm ten dice of 2 each.
    expect(ogreNow.condition).toBe("active");
    expect(ogreNow.maxHp - ogreNow.hp).toBeGreaterThanOrEqual(20);
    expect(ogreNow.maxHp - ogreNow.hp).toBeLessThan(40);
  });
});
