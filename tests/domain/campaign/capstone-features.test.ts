import { describe, expect, it } from "vitest";

import { countercharmCovers } from "../../../src/domain/campaign/engine/combat/attack-rules.js";
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

// An ogre alone in the courtyard (goblins would shoot from range) hits the weakest hero, Borin; his Retaliation and Superior Hunter's Defense are read there.
describe("reactions to being hit", () => {
  const ogre = { monsterId: "monster:ogre", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null } as const;

  function struckBorin(features: readonly string[]): Fight {
    const base = partyOfThree();
    const sheet = base.characters["c-borin"];
    if (sheet === undefined) throw new Error("borin");
    const state: CampaignState = {
      ...base,
      characters: { ...base.characters, "c-borin": { ...sheet, features: [...sheet.features, ...features] as typeof sheet.features } },
      heroStatus: { ...base.heroStatus, "c-borin": { hp: 8, resources: { spellSlots: {}, featureUses: {} } } },
    };
    // Heroes roll low, the ogre high: it swings first (a hit, not a critical one), and every die comes up 1.
    return new Fight(state)
      .rolls([1, 1, 1, 20, 19, 15], Array.from({ length: 12 }, () => 1))
      .run(organizer, { kind: "startEncounter", spec: { ...skirmish, partyZoneId: "courtyard", monsters: [ogre] } });
  }
  const lost = (fight: Fight): number => 8 - fight.combatant("c-borin").hp;

  it("Retaliation strikes back at the creature that hurt the hero, using their reaction", () => {
    const fight = struckBorin(["feature:retaliation"]);
    const struckBack = fight.events.some((event) => event.kind === "resolutionDeclared" && event.resolution.actorId === "c-borin" && event.resolution.purpose === "reaction");
    expect(struckBack).toBe(true);
    expect(fight.combatant("c-borin").budget.reaction).toBe(false);
    expect(fight.combatant("ogre").hp).toBeLessThan(fight.combatant("ogre").maxHp);
  });

  it("Superior Hunter's Defense halves the blow and the rest of that kind of damage", () => {
    const plain = struckBorin([]);
    const guarded = struckBorin(["feature:superior-hunters-defense"]);
    expect(lost(plain)).toBeGreaterThan(0);
    expect(lost(guarded)).toBe(Math.floor(lost(plain) / 2));
    expect(guarded.combatant("c-borin").effects.some((effect) => effect.definition === "feature:superior-hunters-defense")).toBe(true);
    expect(guarded.combatant("c-borin").budget.reaction).toBe(false);
  });
});

describe("Countercharm", () => {
  it("gives the bard's friends in the same place advantage against fear and charm, but not against poison", () => {
    const base = partyOfThree();
    const sheet = base.characters["c-elspeth"];
    if (sheet === undefined) throw new Error("elspeth");
    const state: CampaignState = { ...base, characters: { ...base.characters, "c-elspeth": { ...sheet, features: [...sheet.features, "feature:countercharm"] as typeof sheet.features } } };
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    const encounter = fight.encounter;
    const mira = fight.combatant("c-mira");
    if (encounter === null) throw new Error("no encounter");
    expect(countercharmCovers(encounter, mira, { conditions: ["condition:frightened"], damageTypes: [], magic: false })).toBe(true);
    expect(countercharmCovers(encounter, mira, { conditions: ["condition:poisoned"], damageTypes: [], magic: false })).toBe(false);
  });
});

describe("Divine Intervention", () => {
  function implore(roll: number): Fight {
    const base = partyOfThree();
    const sheet = base.characters["c-elspeth"];
    if (sheet === undefined) throw new Error("elspeth");
    const state: CampaignState = {
      ...base,
      characters: { ...base.characters, "c-elspeth": { ...sheet, level: 10, features: [...sheet.features, "feature:divine-intervention"] as typeof sheet.features } },
      heroStatus: { ...base.heroStatus, "c-mira": { hp: 3, resources: { spellSlots: {}, featureUses: {} } }, "c-elspeth": { hp: sheet.maxHp, resources: { spellSlots: {}, featureUses: { "feature:divine-intervention": 1 } } } },
    };
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    return fight.rolls([], [roll]).run(sam, { kind: "combatUseFeature", combatantId: "c-elspeth", featureId: "feature:divine-intervention" });
  }

  it("makes the whole party whole when the percentile roll is at or under the cleric's level", () => {
    const fight = implore(10);
    expect(fight.combatant("c-mira").hp).toBe(fight.combatant("c-mira").maxHp);
  });

  it("does nothing when the roll is over it, and the use is still gone", () => {
    const fight = implore(11);
    expect(fight.combatant("c-mira").hp).toBe(3);
    expect(fight.combatant("c-elspeth").resources.featureUses["feature:divine-intervention"]).toBe(0);
  });
});

describe("Hurl Through Hell", () => {
  it("costs the target 10d10 psychic damage and a round out of the fight", () => {
    const base = partyOfThree();
    const sheet = base.characters["c-borin"];
    if (sheet === undefined) throw new Error("borin");
    const state: CampaignState = {
      ...base,
      characters: { ...base.characters, "c-borin": { ...sheet, features: [...sheet.features, "feature:hurl-through-hell"] as typeof sheet.features } },
      heroStatus: { ...base.heroStatus, "c-borin": { hp: sheet.maxHp, resources: { spellSlots: {}, featureUses: { "feature:hurl-through-hell": 1 } } } },
    };
    const fight = new Fight(state).rolls([5, 20, 4, 3]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, partyZoneId: "courtyard", monsters: [{ monsterId: "monster:ogre", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] } });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "ogre" });
    fight.run(jamie, { kind: "combatUseFeature", combatantId: "c-borin", featureId: "feature:hurl-through-hell" });
    fight.rolls([15], [1, ...Array.from({ length: 10 }, () => 3)]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "ogre", weapon: "item:longsword" });
    const ogreNow = fight.combatant("ogre");
    expect(ogreNow.maxHp - ogreNow.hp).toBeGreaterThanOrEqual(30);
    expect(ogreNow.effects.some((effect) => effect.conditions.includes("condition:incapacitated"))).toBe(true);
  });
});

describe("Pact of the Blade and Nature's Ward", () => {
  it("the Blade puts a weapon in the warlock's hand, and the Ward shields a druid from poison", () => {
    const base = partyOfThree();
    const sheet = base.characters["c-elspeth"];
    if (sheet === undefined) throw new Error("elspeth");
    const state: CampaignState = { ...base, characters: { ...base.characters, "c-elspeth": { ...sheet, features: [...sheet.features, "feature:pact-of-the-blade", "feature:natures-ward"] as typeof sheet.features } } };
    const fight = new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    const hero = fight.combatant("c-elspeth");
    expect(hero.attacks.some((attack) => attack.weapon === "item:pact-blade")).toBe(true);
    expect(hero.traits.some((trait) => trait.kind === "conditionImmunity" && trait.conditions.includes("condition:poisoned"))).toBe(true);
  });
});

describe("Hunter's Multiattack", () => {
  it("makes one melee attack strike every foe the hero is in melee with", () => {
    const base = partyOfThree();
    const sheet = base.characters["c-borin"];
    if (sheet === undefined) throw new Error("borin");
    const state: CampaignState = { ...base, characters: { ...base.characters, "c-borin": { ...sheet, features: [...sheet.features, "feature:hunter-multiattack"] as typeof sheet.features } } };
    const fight = new Fight(state).rolls([5, 20, 4, 3, 2]).run(organizer, { kind: "startEncounter", spec: { ...skirmish, partyZoneId: "courtyard" } });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-b" });
    fight.rolls([15, 15], [1, 1]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword" });
    const swing = fight.events.find((event) => event.kind === "resolutionDeclared" && event.resolution.actorId === "c-borin");
    expect(swing?.kind === "resolutionDeclared" ? [...swing.resolution.targetIds].sort() : []).toEqual(["goblin-a", "goblin-b"]);
  });
});
