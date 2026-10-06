import { describe, expect, it } from "vitest";
import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import { turnOptions } from "../../../src/domain/campaign/combat/turn-rules.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import type { MonsterDefinition } from "../../../src/domain/campaign/rules/content-definitions.js";
import { mayWildShapeInto } from "../../../src/domain/campaign/rules/wild-shape-rules.js";
import { alex, jamie, organizer, partyOfThree, ruleset, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

function ofKind<K extends CampaignEvent["kind"]>(fight: Fight, kind: K): Extract<CampaignEvent, { kind: K }>[] {
  return fight.events.filter((event): event is Extract<CampaignEvent, { kind: K }> => event.kind === kind);
}

function druidOfLevel(level: number): CampaignState {
  const base = partyOfThree();
  const elspeth = base.characters["c-elspeth"];
  if (elspeth === undefined) throw new Error("fixture");
  return { ...base, characters: { ...base.characters, "c-elspeth": { ...elspeth, level, features: [...elspeth.features, "feature:wild-shape" as const] } } };
}

// Ends the turns of whoever is up, hero or not, until it is this combatant's.
function passTurnsTo(fight: Fight, combatantId: string): void {
  const owners: Record<string, typeof alex> = { "c-mira": alex, "c-borin": jamie, "c-elspeth": sam };
  for (let guard = 0; guard < 12 && fight.current !== combatantId; guard += 1) {
    const id = fight.current ?? "";
    const owner = owners[id];
    if (owner === undefined) throw new Error(`${id} is not a hero; the fight should have played its turn.`);
    fight.run(owner, { kind: "endTurn", combatantId: id });
  }
}

const alone = (monsterId: `monster:${string}`): EncounterSpec => ({ ...skirmish, monsters: [{ monsterId, zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] });

describe("Multiattack", () => {
  it("has an owlbear swing its beak and then its claws in one turn", () => {
    // Three heroes roll low; the owlbear rolls 20 and goes first.
    const fight = new Fight(partyOfThree()).rolls([1, 1, 1, 20]).run(organizer, { kind: "startEncounter", spec: alone("monster:owlbear") });
    const owlbear = Object.values(fight.encounter.combatants).find((combatant) => combatant.side === "foes");
    expect(owlbear?.traits).toContainEqual({ kind: "multiattack", weapons: ["item:beak", "item:claw"] });
    const weapons = ofKind(fight, "resolutionDeclared").flatMap((event) => (event.resolution.source.kind === "weapon" ? [event.resolution.source.option.weapon] : []));
    // Both swings came in the owlbear's one turn, before the first hero's turn began.
    expect(weapons).toEqual(["item:beak", "item:claw"]);
    expect(fight.kinds().filter((kind) => kind === "turnStarted")).toHaveLength(2);
  });

  it("gives a wolf its one bite: no Multiattack, no second swing", () => {
    const fight = new Fight(partyOfThree()).rolls([1, 1, 1, 20]).run(organizer, { kind: "startEncounter", spec: alone("monster:wolf") });
    const wolfSwings = ofKind(fight, "resolutionDeclared").filter((event) => event.resolution.source.kind === "weapon");
    expect(wolfSwings).toHaveLength(1);
  });
});

describe("Bonus-action spells", () => {
  const fightOf = (): Fight => new Fight(partyOfThree()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });

  it("allows only a one-action cantrip after a bonus-action spell", () => {
    const fight = fightOf().rolls([15], [2]);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:healing-word", slotLevel: 1, targetIds: ["c-mira"] });
    expect(fight.combatant("c-elspeth").budget.bonusSpellCast).toBe(true);
    expect(fight.reject(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:cure-wounds", slotLevel: 1, targetIds: ["c-mira"] })).toEqual({ code: "bonusSpellCast" });
    const options = turnOptions(fight.encounter, fight.state.characters["c-elspeth"], ruleset().content, ruleset().houseRules, "c-elspeth");
    expect(options?.spells.map((entry) => entry.spell.id)).not.toContain("spell:cure-wounds");
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
    expect(fight.combatant("c-elspeth").budget.action).toBe(false);
  });

  it("lets a leveled spell come first and a bonus-action spell follow", () => {
    const fight = fightOf().rolls([15], [2, 2]);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:cure-wounds", slotLevel: 1, targetIds: ["c-mira"] });
    expect(fight.combatant("c-elspeth").budget.bonusSpellCast).toBe(false);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:healing-word", slotLevel: 1, targetIds: ["c-mira"] });
    expect(fight.combatant("c-elspeth").budget.bonusSpellCast).toBe(true);
  });

  it("forgets it on the next turn", () => {
    const fight = fightOf().rolls([15], [2]);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:healing-word", slotLevel: 1, targetIds: ["c-mira"] });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    expect(fight.combatant("c-elspeth").budget.bonusSpellCast).toBe(true);
    // Around to Elspeth again: the flag is fresh.
    passTurnsTo(fight, "c-elspeth");
    expect(fight.combatant("c-elspeth").budget.bonusSpellCast).toBe(false);
  });
});

describe("Wild Shape", () => {
  const shapedFight = (level: number, rolls: readonly number[] = [5, 4, 20, 3, 2], spec: EncounterSpec = skirmish): Fight =>
    new Fight(druidOfLevel(level)).rolls(rolls).run(organizer, { kind: "startEncounter", spec });

  it("offers beasts by the druid's level", () => {
    const content = ruleset().content;
    const of = (id: `monster:${string}`): MonsterDefinition => {
      const beast = content.find(id);
      if (beast?.kind !== "monster") throw new Error(id);
      return beast;
    };
    expect(mayWildShapeInto(2, of("monster:wolf"))).toBe(true);
    expect(mayWildShapeInto(2, of("monster:black-bear"))).toBe(false);
    expect(mayWildShapeInto(4, of("monster:black-bear"))).toBe(true);
    expect(mayWildShapeInto(4, of("monster:giant-bat"))).toBe(false);
    expect(mayWildShapeInto(2, of("monster:crocodile"))).toBe(false);
    expect(mayWildShapeInto(4, of("monster:crocodile"))).toBe(true);
    expect(mayWildShapeInto(8, of("monster:giant-bat"))).toBe(true);
    expect(mayWildShapeInto(8, of("monster:brown-bear"))).toBe(true);
    expect(mayWildShapeInto(8, of("monster:owlbear"))).toBe(false);
    expect(mayWildShapeInto(1, of("monster:wolf"))).toBe(false);
  });

  it("lists the level 2 forms and refuses one beyond the cap", () => {
    const fight = shapedFight(2);
    const options = turnOptions(fight.encounter, fight.state.characters["c-elspeth"], ruleset().content, ruleset().houseRules, "c-elspeth");
    expect(options?.wildShapeForms).toContain("monster:wolf");
    expect(options?.wildShapeForms).not.toContain("monster:black-bear");
    expect(fight.reject(sam, { kind: "combatWildShape", combatantId: "c-elspeth", monsterId: "monster:black-bear" })).toEqual({ code: "unknownFeature" });
  });

  it("allows two uses, then none until a rest", () => {
    const fight = shapedFight(2);
    fight.run(sam, { kind: "combatWildShape", combatantId: "c-elspeth", monsterId: "monster:wolf" });
    expect(fight.combatant("c-elspeth").resources.featureUses["feature:wild-shape"]).toBe(1);
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    passTurnsTo(fight, "c-elspeth");
    fight.run(sam, { kind: "combatWildShape", combatantId: "c-elspeth" });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    passTurnsTo(fight, "c-elspeth");
    fight.run(sam, { kind: "combatWildShape", combatantId: "c-elspeth", monsterId: "monster:wolf" });
    expect(fight.combatant("c-elspeth").resources.featureUses["feature:wild-shape"]).toBe(0);
    fight.run(sam, { kind: "combatWildShape", combatantId: "c-elspeth" });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    passTurnsTo(fight, "c-elspeth");
    expect(fight.reject(sam, { kind: "combatWildShape", combatantId: "c-elspeth", monsterId: "monster:wolf" })).toEqual({ code: "noUsesLeft" });
  });

  it("carries damage past the beast's last hit point over to the druid", () => {
    // Elspeth 20 then the ogre 15; the heroes' others roll low.
    const fight = shapedFight(2, [1, 1, 20, 15], alone("monster:ogre"));
    const before = fight.combatant("c-elspeth");
    fight.run(sam, { kind: "combatWildShape", combatantId: "c-elspeth", monsterId: "monster:wolf" });
    // Leave the wolf on 1 hit point so the ogre picks the druid, then let it hit for 3 + 3 + 4 = 10.
    const wolf = fight.combatant("c-elspeth");
    fight.state = { ...fight.state, encounter: { ...fight.encounter, combatants: { ...fight.encounter.combatants, "c-elspeth": { ...wolf, hp: 1 } } } };
    fight.rolls([10], [3, 3]).run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    const druid = fight.combatant("c-elspeth");
    expect(druid.wildShapeOriginal).toBeNull();
    expect(druid.maxHp).toBe(before.maxHp);
    // The ogre's club: 2d8 + 4 = 10, one point on the beast, nine on the druid.
    expect(druid.hp).toBe(before.hp - 9);
  });
});

// Ends each hero's turn for the rest of this round; the monsters take theirs on the way, and the next round opens.
function passHeroTurns(fight: Fight): void {
  const owners: Record<string, typeof alex> = { "c-mira": alex, "c-borin": jamie, "c-elspeth": sam };
  const round = fight.encounter.round;
  for (let guard = 0; guard < 12 && fight.encounter.round === round; guard += 1) {
    const id = fight.current ?? "";
    const owner = owners[id];
    if (owner === undefined) return;
    fight.run(owner, { kind: "endTurn", combatantId: id });
  }
}

const monsterId = (fight: Fight): string => Object.values(fight.encounter.combatants).find((combatant) => combatant.side === "foes")?.id ?? "";

describe("Breath weapons", () => {
  it("catches every hero in a young dragon's breath", () => {
    const fight = new Fight(partyOfThree()).rolls([1, 1, 1, 20]).run(organizer, { kind: "startEncounter", spec: alone("monster:young-red-dragon") });
    const declared = ofKind(fight, "resolutionDeclared");
    expect(declared).toHaveLength(1);
    expect(declared[0]?.resolution.source).toMatchObject({ kind: "area", area: { weapon: "item:fire-breath", ability: "dex", dc: 17 } });
    expect(declared[0]?.resolution.targetIds.slice().sort()).toEqual(["c-borin", "c-elspeth", "c-mira"]);
    expect(fight.combatant(monsterId(fight)).cooldowns["item:fire-breath"]).toBe(3);
  });

  it("breathes on its first turn and again on its fourth, biting and clawing in between", () => {
    // The heroes go first, and are made tough enough to last.
    const fight = new Fight(partyOfThree()).rolls([1, 1, 20, 15]).run(organizer, { kind: "startEncounter", spec: alone("monster:young-red-dragon") });
    const combatants = Object.fromEntries(Object.entries(fight.encounter.combatants).map(([id, combatant]) => [id, combatant.side === "party" ? { ...combatant, hp: 900, maxHp: 900 } : combatant]));
    fight.state = { ...fight.state, encounter: { ...fight.encounter, combatants } };
    const breaths: number[] = [];
    for (let round = 1; round <= 4; round += 1) {
      passHeroTurns(fight);
      breaths.push(ofKind(fight, "resolutionDeclared").filter((event) => event.resolution.source.kind === "area").length);
    }
    expect(breaths).toEqual([1, 1, 1, 2]);
  });

  it("halves the damage for a hero who saves", () => {
    // Every d20 is a 1 (fail) except one save, a 20. Sixteen d6, all threes: 48 damage.
    const fight = new Fight(partyOfThree()).rolls([1, 1, 1, 20, 20, 1, 1], Array.from({ length: 16 }, () => 3)).run(organizer, { kind: "startEncounter", spec: alone("monster:young-red-dragon") });
    const damages = ofKind(fight, "combatantHpChanged").map((event) => -event.change).sort((a, b) => a - b);
    expect(damages).toEqual([24, 48, 48]);
  });
});

describe("Regeneration", () => {
  const troll = (): Fight => {
    const fight = new Fight(partyOfThree()).rolls([1, 1, 20, 1]).run(organizer, { kind: "startEncounter", spec: alone("monster:troll") });
    const id = monsterId(fight);
    const wounded = { ...fight.combatant(id), hp: 40 };
    fight.state = { ...fight.state, encounter: { ...fight.encounter, combatants: { ...fight.encounter.combatants, [id]: wounded } } };
    return fight;
  };

  it("heals 10 at the start of the troll's turn", () => {
    const fight = troll();
    passHeroTurns(fight);
    const healed = ofKind(fight, "combatantHpChanged").filter((event) => event.cause === "healing" && event.combatantId === monsterId(fight));
    expect(healed.map((event) => event.change)).toEqual([10]);
  });

  it("skips a turn after the troll takes fire, and only one", () => {
    const fight = troll();
    const id = monsterId(fight);
    fight.state = { ...fight.state, encounter: { ...fight.encounter, combatants: { ...fight.encounter.combatants, [id]: { ...fight.combatant(id), regenBlocked: true } } } };
    passHeroTurns(fight);
    expect(ofKind(fight, "combatantHpChanged").filter((event) => event.cause === "healing" && event.combatantId === id)).toHaveLength(0);
    expect(fight.combatant(id).regenBlocked).toBe(false);
  });
});

describe("Legendary Resistance", () => {
  it("turns a dragon's failed save into a success and spends a use", () => {
    const fight = new Fight(partyOfThree()).rolls([1, 1, 20, 15]).run(organizer, { kind: "startEncounter", spec: alone("monster:adult-red-dragon") });
    const id = monsterId(fight);
    expect(fight.combatant(id).resources.featureUses["trait:legendary-resistance"]).toBe(3);
    const before = fight.combatant(id).hp;
    fight.rolls([1]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: [id] });
    expect(fight.combatant(id).resources.featureUses["trait:legendary-resistance"]).toBe(2);
    expect(fight.combatant(id).hp).toBe(before);
  });
});

describe("Spellcasting monsters", () => {
  it("has a mage open with its highest spell and spend the slot", () => {
    const fight = new Fight(partyOfThree()).rolls([1, 1, 1, 20]).run(organizer, { kind: "startEncounter", spec: alone("monster:mage") });
    const source = ofKind(fight, "resolutionDeclared")[0]?.resolution.source;
    expect(source).toMatchObject({ kind: "spell", spellId: "spell:cone-of-cold", slotLevel: 5 });
    expect(fight.combatant(monsterId(fight)).resources.spellSlots[5]).toBe(0);
  });

  it("casts an innate spell with no slot, and counts a per-day one", () => {
    // Thunderwave reaches 15 feet, so the djinni starts 10 feet away.
    const near = { ...alone("monster:djinni"), edges: [{ from: "gate", to: "courtyard", feet: 10 }] };
    const fight = new Fight(partyOfThree()).rolls([1, 1, 1, 20]).run(organizer, { kind: "startEncounter", spec: near });
    const source = ofKind(fight, "resolutionDeclared")[0]?.resolution.source;
    expect(source).toMatchObject({ kind: "spell", spellId: "spell:thunderwave", slotLevel: 1 });
    expect(fight.combatant(monsterId(fight)).resources.spellSlots).toEqual({});
  });

  it("falls back to its weapon when it has no spell that harms", () => {
    const fight = new Fight(partyOfThree()).rolls([1, 1, 1, 20]).run(organizer, { kind: "startEncounter", spec: alone("monster:goblin") });
    expect(ofKind(fight, "resolutionDeclared")[0]?.resolution.source.kind).toBe("weapon");
  });
});

describe("Legendary actions", () => {
  it("has an adult dragon strike with its tail or wings at the end of a hero's turn, and only once per turn", () => {
    // The heroes go first, and are made tough enough to last.
    const fight = new Fight(partyOfThree()).rolls([1, 1, 20, 15]).run(organizer, { kind: "startEncounter", spec: alone("monster:adult-red-dragon") });
    const tough = Object.fromEntries(Object.entries(fight.encounter.combatants).map(([id, combatant]) => [id, combatant.side === "party" ? { ...combatant, hp: 900, maxHp: 900 } : combatant]));
    fight.state = { ...fight.state, encounter: { ...fight.encounter, combatants: tough } };
    for (let round = 0; round < 4; round += 1) passHeroTurns(fight);
    const legendary = ofKind(fight, "resolutionDeclared").filter((event) => event.resolution.purpose === "legendary");
    expect(legendary.length).toBeGreaterThan(0);
    // The tail strike, or the wing beat when several creatures are close.
    expect(legendary.every((event) => (event.resolution.source.kind === "weapon" && event.resolution.source.option.weapon === "item:tail") || (event.resolution.source.kind === "area" && event.resolution.source.area.weapon === "item:wing-attack"))).toBe(true);
    // Never two after the same turn: each is spent on a different turn's end.
    const turns = ofKind(fight, "monsterStateChanged").flatMap((event) => (event.legendaryTurn === undefined ? [] : [event.legendaryTurn]));
    expect(new Set(turns).size).toBe(turns.length);
    // Its legendary actions are back after its own turn: no more than three are spent between one of its turns and the next.
    let spent = 0;
    for (const event of fight.events) {
      if (event.kind === "turnStarted" && event.combatantId === monsterId(fight)) spent = 0;
      if (event.kind === "monsterStateChanged" && event.legendarySpent !== undefined) spent += event.legendarySpent;
      expect(spent).toBeLessThanOrEqual(3);
    }
  });
});

describe("Frightful Presence", () => {
  it("is used for free at the start of a dragon's turn, and the turn goes on with a breath", () => {
    const fight = new Fight(partyOfThree()).rolls([1, 1, 20, 15]).run(organizer, { kind: "startEncounter", spec: alone("monster:adult-red-dragon") });
    const tough = Object.fromEntries(Object.entries(fight.encounter.combatants).map(([id, combatant]) => [id, combatant.side === "party" ? { ...combatant, hp: 900, maxHp: 900 } : combatant]));
    fight.state = { ...fight.state, encounter: { ...fight.encounter, combatants: tough } };
    passHeroTurns(fight);
    const uses = ofKind(fight, "resolutionDeclared").map((event) => (event.resolution.source.kind === "area" ? event.resolution.source.area.weapon : event.resolution.source.kind));
    expect(uses).toEqual(["item:frightful-presence", "item:fire-breath"]);
    const frightened = Object.values(fight.encounter.combatants).filter((combatant) => combatant.effects.some((effect) => effect.definition === "condition:frightened"));
    expect(frightened.length).toBeGreaterThan(0);
  });
});
