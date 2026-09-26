import { describe, expect, it } from "vitest";

import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import { formatDiceExpression } from "../../../src/domain/campaign/dice/dice-expression.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, newCampaign, organizer, partyOfThree, ruleset, run, sam } from "./campaign-fixtures.js";
import { Fight, skirmish } from "./combat-fixtures.js";

// Gate and courtyard 10 ft apart, with a tower beyond the courtyard.
const close: EncounterSpec = {
  ...skirmish,
  zones: [...skirmish.zones, { id: "tower", name: "Tower" }],
  edges: [
    { from: "gate", to: "courtyard", feet: 10 },
    { from: "courtyard", to: "tower", feet: 10 },
  ],
};

function ofKind<K extends CampaignEvent["kind"]>(fight: Fight, kind: K): Extract<CampaignEvent, { kind: K }>[] {
  return fight.events.filter((event): event is Extract<CampaignEvent, { kind: K }> => event.kind === kind);
}

function withStatus(state: CampaignState, hp: Record<string, number>): CampaignState {
  const heroStatus = { ...state.heroStatus };
  for (const [id, value] of Object.entries(hp)) {
    heroStatus[id] = { hp: value, resources: { spellSlots: id === "c-elspeth" ? { 1: 2 } : {}, featureUses: id === "c-borin" ? { "feature:second-wind": 1 } : {} } };
  }
  return { ...state, heroStatus };
}

// Mira, Borin, Elspeth, then two goblins. Elspeth rolls 20 and goes first;
// then Mira 8, goblin A 5 (ties with Borin, higher DEX), Borin 5, goblin B 4.
function elspethFirst(state: CampaignState = partyOfThree()): Fight {
  return new Fight(state).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
}

describe("spellcasting", () => {
  it("gives a caster spell attack and save DC from the casting ability", () => {
    const elspeth = elspethFirst().combatant("c-elspeth");
    expect(elspeth.spellcasting).toMatchObject({ attackBonus: 5, saveDc: 13, modifier: 3 });
    expect(elspeth.resources.spellSlots).toEqual({ 1: 2 });
    expect(elspeth.armorClass).toBe(18);
  });

  it("casts Sacred Flame as a Dexterity save against the caster's DC, with no slot spent", () => {
    const failed = elspethFirst().rolls([5], [6]);
    failed.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
    expect(ofKind(failed, "checkRolled")[0]).toMatchObject({ landed: true, roll: { total: 7 } });
    expect(failed.combatant("goblin-a").hp).toBe(1);
    expect(failed.combatant("c-elspeth").resources.spellSlots).toEqual({ 1: 2 });

    const saved = elspethFirst().rolls([15]);
    saved.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
    expect(ofKind(saved, "checkRolled")[0]).toMatchObject({ landed: false });
    expect(saved.kinds()).not.toContain("effectRollsRequested");
    expect(saved.combatant("goblin-a").hp).toBe(7);
  });

  it("lands Guiding Bolt's advantage on the next attack against the target, which Sneak Attack then uses", () => {
    const fight = elspethFirst().rolls([12], [1, 1, 1, 1]);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:guiding-bolt", slotLevel: 1, targetIds: ["goblin-a"] });
    expect(fight.combatant("goblin-a")).toMatchObject({ hp: 3, effects: [{ kind: "attackedWithAdvantage", sourceId: "c-elspeth" }] });
    expect(fight.combatant("c-elspeth").resources.spellSlots).toEqual({ 1: 1 });

    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.rolls([3, 15], [1, 1]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const shot = ofKind(fight, "resolutionDeclared").at(-1);
    expect(Object.values(shot?.resolution.checks ?? {})[0]?.spec.mode).toBe("advantage");
    expect(shot?.resolution.sneakAttack).toBe(true);
    const damage = ofKind(fight, "effectRollsRequested").at(-1);
    const spec = Object.values(damage?.rolls ?? {})[0]?.spec;
    expect(spec?.kind === "dice" ? formatDiceExpression(spec.expression) : "").toBe("2d6 + 3");
    expect(fight.combatant("goblin-a").condition).toBe("dead");
    expect(fight.events).toContainEqual({ kind: "sneakAttackUsed", combatantId: "c-mira" });
  });

  it("heals with Cure Wounds plus Disciple of Life, bringing a downed hero back", () => {
    const fight = elspethFirst(withStatus(partyOfThree(), { "c-mira": 0 })).rolls([], [4]);
    expect(fight.combatant("c-mira").condition).toBe("stable");
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:cure-wounds", slotLevel: 1, targetIds: ["c-mira"] });
    // 1d8 (4) + WIS 3 + Disciple of Life (2 + spell level 1) = 10, capped at 9.
    expect(ofKind(fight, "combatantHpChanged").at(-1)).toMatchObject({ combatantId: "c-mira", change: 9, hp: 9, condition: "active", cause: "healing" });
  });

  it("casts Healing Word as a bonus action and still allows a cantrip with the action", () => {
    const fight = elspethFirst(withStatus(partyOfThree(), { "c-mira": 1 })).rolls([15], [2]);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:healing-word", slotLevel: 1, targetIds: ["c-mira"] });
    expect(fight.combatant("c-mira").hp).toBe(9);
    expect(fight.combatant("c-elspeth").budget).toMatchObject({ action: true, bonusAction: false });
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
    expect(fight.combatant("c-elspeth").budget.action).toBe(false);
  });

  it("refuses casting without a slot, with too many targets, or out of range", () => {
    const fight = elspethFirst();
    const noSlots = { ...fight.state };
    const encounter = fight.encounter;
    const elspeth = fight.combatant("c-elspeth");
    noSlots.encounter = { ...encounter, combatants: { ...encounter.combatants, "c-elspeth": { ...elspeth, resources: { ...elspeth.resources, spellSlots: { 1: 0 } } } } };
    const drained = new Fight(noSlots);
    expect(drained.reject(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:bless", slotLevel: 1, targetIds: ["c-mira"] })).toEqual({
      code: "noSpellSlot",
      slotLevel: 1,
    });
    expect(
      fight.reject(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:bless", slotLevel: 1, targetIds: ["c-mira", "c-borin", "c-elspeth", "goblin-a"] }),
    ).toEqual({ code: "invalidTargets", maxTargets: 3 });
    expect(fight.reject(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:cure-wounds", slotLevel: 1, targetIds: ["goblin-a"] })).toEqual({
      code: "outOfRange",
    });
    expect(fight.reject(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:fireball", slotLevel: 3, targetIds: ["goblin-a"] })).toEqual({
      code: "unknownSpell",
    });
  });
});

describe("Bless and concentration", () => {
  it("adds 1d4 to blessed creatures' attacks and saves, and ends when concentration breaks", () => {
    const fight = elspethFirst();
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:bless", slotLevel: 1, targetIds: ["c-elspeth", "c-mira", "c-borin"] });
    expect(fight.combatant("c-elspeth").concentration).toMatchObject({ spellId: "spell:bless" });
    expect(fight.combatant("c-borin").effects).toMatchObject([{ kind: "bonusDie", appliesTo: ["attack", "save"], expiresAtRound: 11 }]);

    // Mira's attack roll carries the Bless die.
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });
    fight.rolls([2], [1]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const attack = ofKind(fight, "resolutionDeclared").at(-1);
    expect(Object.values(attack?.resolution.checks ?? {})[0]?.spec.bonusDice).toEqual([{ source: "spell:bless", die: { terms: [{ count: 1, sides: 4 }], modifier: 0 } }]);

    // Goblin A shoots Elspeth (tied lowest HP, first by ID) for 5; her DC 10
    // Constitution save: 3 + 1 (CON) + 1 (Bless) = 5 fails.
    fight.rolls([15, 3], [3, 1]).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    expect(fight.events).toContainEqual(expect.objectContaining({ kind: "concentrationSaveRolled", combatantId: "c-elspeth", dc: 10, kept: false }));
    expect(fight.events).toContainEqual({ kind: "concentrationEnded", combatantId: "c-elspeth", reason: "failedSave" });
    for (const hero of ["c-elspeth", "c-mira", "c-borin"]) expect(fight.combatant(hero).effects).toEqual([]);
  });
});

describe("class features", () => {
  // Borin 21, goblin A 7, goblin B 6, Mira 4.
  function borinFirst(state: CampaignState = newCampaign(), spec: EncounterSpec = close): Fight {
    return new Fight(state).rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec });
  }

  it("heals with Second Wind as a bonus action, once per rest, and keeps the spent use after the fight", () => {
    const fight = borinFirst(withStatus(newCampaign(), { "c-borin": 5 })).rolls([], [4]);
    fight.run(jamie, { kind: "combatUseFeature", combatantId: "c-borin", featureId: "feature:second-wind" });
    // 1d10 (4) + fighter level 1.
    expect(fight.combatant("c-borin")).toMatchObject({ hp: 10, budget: { bonusAction: false, action: true } });
    expect(fight.reject(jamie, { kind: "combatUseFeature", combatantId: "c-borin", featureId: "feature:second-wind" })).toEqual({ code: "noUsesLeft" });
  });

  it("adds Sneak Attack when an ally is next to the target", () => {
    // Two zones only: the goblins have nowhere to slip away to.
    const fight = borinFirst(newCampaign(), { ...skirmish, edges: [{ from: "gate", to: "courtyard", feet: 10 }] });
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" });
    // Both goblins roll natural 1s against Borin.
    fight.rolls([1, 1]).run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    fight.rolls([12], [1, 1]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    expect(ofKind(fight, "resolutionDeclared").at(-1)?.resolution.sneakAttack).toBe(true);
    expect(fight.combatant("goblin-a").hp).toBe(2);
  });

  it("restores features on a short rest and everything on a long rest", () => {
    const tired = withStatus(newCampaign(), { "c-borin": 3 });
    const spent = { ...tired, heroStatus: { ...tired.heroStatus, "c-borin": { hp: 3, resources: { spellSlots: {}, featureUses: { "feature:second-wind": 0 } } } } };
    const short = new Fight(spent).run(organizer, { kind: "takeRest", rest: "short" });
    // Borin's one Hit Die (d10: 6 on average, plus Con +2) heals 8.
    expect(short.state.heroStatus["c-borin"]).toEqual({ hp: 11, resources: { spellSlots: {}, featureUses: { "feature:second-wind": 1 } }, hitDice: 0 });
    // With no dice left, a second short rest heals nothing; a long rest brings one back.
    const again = run(short.state, organizer, { kind: "takeRest", rest: "short" });
    expect(again.state.heroStatus["c-borin"]?.hp).toBe(11);
    const overnight = run(again.state, organizer, { kind: "takeRest", rest: "long" });
    expect(overnight.state.heroStatus["c-borin"]).toMatchObject({ hp: 12, hitDice: 1 });
    // Healthy heroes keep their dice.
    expect(short.state.heroStatus["c-mira"]).toMatchObject({ hp: 9, hitDice: 1 });
    const long = new Fight(spent).run(organizer, { kind: "takeRest", rest: "long" });
    expect(long.state.heroStatus["c-borin"]?.hp).toBe(12);
    expect(long.state.heroStatus["c-elspeth"]).toBeUndefined();
    expect(new Fight(spent).reject(alex, { kind: "takeRest", rest: "long" })).toEqual({ code: "notOrganizer" });
  });
});

describe("opportunity attacks and escape", () => {
  function borinEngagedWithGoblin(): Fight {
    const fight = new Fight().rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec: close });
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" });
    return fight;
  }

  it("lets a foe strike before a hero leaves its reach, spending its reaction", () => {
    const fight = borinEngagedWithGoblin().rolls([15], [2]);
    fight.run(jamie, { kind: "combatWithdraw", combatantId: "c-borin" });
    const opportunity = ofKind(fight, "resolutionDeclared").at(-1);
    expect(opportunity?.resolution).toMatchObject({ actorId: "goblin-a", purpose: "opportunity", targetIds: ["c-borin"] });
    expect(opportunity?.cost).toMatchObject({ reaction: true, action: false });
    expect(fight.combatant("c-borin").hp).toBe(8);
    const kinds = fight.kinds();
    expect(kinds.lastIndexOf("resolutionFinished")).toBeLessThan(kinds.lastIndexOf("combatantWithdrew"));
    expect(fight.combatant("goblin-a").budget.reaction).toBe(false);
    expect(fight.encounter.engagements).toEqual([]);
  });

  it("provokes nothing after Disengage", () => {
    const fight = new Fight().rolls([1, 20, 5, 4]).run(organizer, { kind: "startEncounter", spec: close });
    fight.run(jamie, { kind: "combatDisengage", combatantId: "c-borin" });
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" });
    fight.run(jamie, { kind: "combatWithdraw", combatantId: "c-borin" });
    expect(fight.kinds()).not.toContain("resolutionDeclared");
  });

  it("has a goblin use Nimble Escape to slip away and shoot", () => {
    const fight = borinEngagedWithGoblin().rolls([1, 1]);
    fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    expect(fight.events).toContainEqual({ kind: "actionTaken", combatantId: "goblin-a", action: "disengage", bonus: true });
    expect(fight.combatant("goblin-a").zoneId).toBe("tower");
    const shot = ofKind(fight, "resolutionDeclared").find((event) => event.resolution.actorId === "goblin-a");
    expect(shot?.resolution).toMatchObject({ purpose: "action", source: { option: { weapon: "item:shortbow" } } });
    expect(ofKind(fight, "resolutionDeclared").some((event) => event.resolution.purpose === "opportunity")).toBe(false);
  });
});

describe("prone", () => {
  it("knocks a hero prone with a wolf bite on a failed save, then they stand for half their speed", () => {
    const wolves: EncounterSpec = {
      ...close,
      monsters: [
        { monsterId: "monster:wolf", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null },
        { monsterId: "monster:wolf", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null },
      ],
    };
    // Wolves 22 and 21, then Mira 4 and Borin 3. Wolf A bites Mira (hit, 4
    // damage) and she fails the DC 11 Strength save; wolf B rolls two 1s.
    const fight = new Fight().rolls([1, 2, 20, 19, 15, 5, 1, 1], [1, 1]).run(organizer, { kind: "startEncounter", spec: wolves });
    expect(fight.events).toContainEqual({ kind: "conditionAdded", combatantId: "c-mira", condition: "condition:prone" });
    const second = ofKind(fight, "resolutionDeclared")[1];
    expect(Object.values(second?.resolution.checks ?? {})[0]?.spec.mode).toBe("advantage");
    expect(fight.current).toBe("c-mira");
    expect(fight.combatant("c-mira")).toMatchObject({ conditions: [], budget: { movement: 15 } });
  });
});

describe("protected while away", () => {
  const bugbearBeside: EncounterSpec = {
    ...skirmish,
    monsters: [{ monsterId: "monster:bugbear", zoneId: "gate", npcId: null, fleeBelowHpFraction: null }],
  };
  function awayMira(): CampaignState {
    const state = newCampaign();
    return { ...state, members: { ...state.members, "u-alex": { ...state.members["u-alex"]!, availability: "away" } } };
  }

  it("leaves an away hero at 0 HP and stable instead of killing them", () => {
    // The bugbear crits Mira for 8 x 4 + 2 = 34, far past massive damage.
    const fight = new Fight(awayMira()).rolls([1, 2, 20, 20], [8, 8, 8, 8]).run(organizer, { kind: "startEncounter", spec: bugbearBeside });
    expect(ofKind(fight, "combatantHpChanged")[0]).toMatchObject({ combatantId: "c-mira", hp: 0, condition: "stable", cause: "protectedWhileAway" });
    expect(fight.kinds()).not.toContain("deathSaveRequested");
  });

  it("follows the standard rules when the table turns protection off", () => {
    const fight = new Fight(awayMira(), ruleset({ "away-safety": "standard" }))
      .rolls([1, 2, 20, 20], [8, 8, 8, 8])
      .run(organizer, { kind: "startEncounter", spec: bugbearBeside });
    expect(ofKind(fight, "combatantHpChanged")[0]).toMatchObject({ combatantId: "c-mira", condition: "dead", cause: "massiveDamage" });
  });

  it("stabilizes a dying hero the moment their player is marked away", () => {
    // Goblin A 22 crits Mira down; Borin 19 is up next.
    const fight = new Fight().rolls([2, 18, 20, 1, 20], [6, 6]).run(organizer, { kind: "startEncounter", spec: skirmish });
    expect(fight.combatant("c-mira").condition).toBe("unconscious");
    expect(fight.current).toBe("c-borin");
    fight.run(organizer, { kind: "markAway", userId: "u-alex" });
    expect(fight.combatant("c-mira").condition).toBe("stable");
  });
});
