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
