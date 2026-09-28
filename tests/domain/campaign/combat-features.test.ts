import { describe, expect, it } from "vitest";

import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import { turnOptions } from "../../../src/domain/campaign/combat/turn-rules.js";
import { formatDiceExpression } from "../../../src/domain/campaign/dice/dice-expression.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, borin, jamie, newCampaign, organizer, partyOfThree, ruleset, run, sam, system } from "./campaign-fixtures.js";
import { Fight, skirmish, startedFight } from "./combat-fixtures.js";

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
    // The advantage lasts until the end of Elspeth's next turn, and the first attack against the goblin uses it up.
    expect(fight.combatant("goblin-a")).toMatchObject({
      hp: 3,
      effects: [{ definition: "spell:guiding-bolt", sourceId: "c-elspeth", modifiers: [{ kind: "attacksAgainst", mode: "advantage", usesUp: true }], clock: { follows: "source", boundary: "end", untilRound: 2 } }],
    });
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
    expect(fight.combatant("c-borin").effects).toMatchObject([
      { definition: "spell:bless", modifiers: [{ kind: "bonusDie", appliesTo: ["attack", "save"] }], clock: { follows: "source", boundary: "start", untilRound: 11 } },
    ]);

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
    expect(short.state.heroStatus["c-borin"]).toEqual({ hp: 11, resources: { spellSlots: {}, pactSlots: {}, featureUses: { "feature:second-wind": 1 } }, hitDice: 0, exhaustion: 0 });
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

  it("lets a hero with Extra Attack attack twice on one action, then spends it", () => {
    const base = newCampaign();
    const borin = base.characters["c-borin"];
    if (borin === undefined) throw new Error("fixture");
    const leveled = { ...base, characters: { ...base.characters, "c-borin": { ...borin, level: 5, features: [...borin.features, "feature:extra-attack" as const] } } };
    const fight = borinFirst(leveled);
    expect(fight.combatant("c-borin").budget.attacksLeft).toBe(2);
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" });
    fight.rolls([1]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword" });
    // The Attack action is spent on the first swing, same as any other
    // action — attacksLeft is what still permits the second one.
    expect(fight.combatant("c-borin").budget).toMatchObject({ action: false, attacksLeft: 1 });
    fight.rolls([1]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword" });
    expect(fight.combatant("c-borin").budget).toMatchObject({ action: false, attacksLeft: 0 });
    expect(fight.reject(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword" })).toEqual({ code: "noActionLeft" });
  });

  it("cannot spend the action on Dodge after the first of two Extra Attack swings", () => {
    const base = newCampaign();
    const borin = base.characters["c-borin"];
    if (borin === undefined) throw new Error("fixture");
    const leveled = { ...base, characters: { ...base.characters, "c-borin": { ...borin, level: 5, features: [...borin.features, "feature:extra-attack" as const] } } };
    const fight = borinFirst(leveled);
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" });
    fight.rolls([1]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword" });
    expect(fight.reject(jamie, { kind: "combatDodge", combatantId: "c-borin" })).toEqual({ code: "noActionLeft" });
    // The menu still offers the second swing Extra Attack still owes.
    const options = turnOptions(fight.encounter, fight.state.characters["c-borin"], ruleset().content, ruleset().houseRules, "c-borin");
    expect(options?.attacks[0]?.targetIds).toContain("goblin-a");
  });

  it("gives a level 11 Fighter a third attack, and a level 20 one a fourth", () => {
    const base = newCampaign();
    const borin = base.characters["c-borin"];
    if (borin === undefined) throw new Error("fixture");
    const veteran = { ...base, characters: { ...base.characters, "c-borin": { ...borin, level: 11, features: [...borin.features, "feature:extra-attack" as const, "feature:extra-attack-2" as const] } } };
    expect(borinFirst(veteran).combatant("c-borin").budget.attacksLeft).toBe(3);

    const legend = { ...base, characters: { ...base.characters, "c-borin": { ...borin, level: 20, features: [...borin.features, "feature:extra-attack" as const, "feature:extra-attack-2" as const, "feature:extra-attack-3" as const] } } };
    expect(borinFirst(legend).combatant("c-borin").budget.attacksLeft).toBe(4);
  });

  it("halves a hit's damage with Uncanny Dodge, spending the reaction so a second hit that round lands in full", () => {
    const base = newCampaign();
    const mira = base.characters["c-mira"];
    if (mira === undefined) throw new Error("fixture");
    const dodgy = { ...base, characters: { ...base.characters, "c-mira": { ...mira, level: 5, features: [...mira.features, "feature:uncanny-dodge" as const] } } };
    // One goblin only, so exactly one attack lands per round.
    const oneGoblin: EncounterSpec = { ...skirmish, monsters: [{ monsterId: "monster:goblin", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] };
    const fight = new Fight(dodgy).rolls([20, 15, 5]).run(organizer, { kind: "startEncounter", spec: oneGoblin });
    fight.run(alex, { kind: "combatDodge", combatantId: "c-mira" });
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    // The goblin (unengaged, so it shoots), disadvantaged by Mira's own Dodge: two dice, the lower kept.
    fight.rolls([15, 18], [4]).run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    // 4 rolled + 2 = 6, halved to 3.
    expect(fight.combatant("c-mira").hp).toBe(6);
    expect(ofKind(fight, "uncannyDodgeUsed")).toEqual([{ kind: "uncannyDodgeUsed", combatantId: "c-mira" }]);
  });

  it("swaps a Wild Shaped hero's whole stat block for the Wolf's, and restores it exactly on reverting", () => {
    const base = partyOfThree();
    const elspeth = base.characters["c-elspeth"];
    if (elspeth === undefined) throw new Error("fixture");
    const druid = { ...base, characters: { ...base.characters, "c-elspeth": { ...elspeth, features: [...elspeth.features, "feature:wild-shape" as const] } } };
    const fight = elspethFirst(druid);
    const before = fight.combatant("c-elspeth");
    expect(before.wildShapeOriginal).toBeNull();

    fight.run(sam, { kind: "combatWildShape", combatantId: "c-elspeth", monsterId: "monster:wolf" });
    const wolf = fight.combatant("c-elspeth");
    expect(wolf).toMatchObject({ armorClass: 13, maxHp: 11, hp: 11, speed: 40, traits: [{ kind: "packTactics" }] });
    expect(wolf.attacks[0]?.weapon).toBe("item:bite");
    expect(wolf.wildShapeOriginal).toMatchObject({ armorClass: before.armorClass, maxHp: before.maxHp, hp: before.hp, speed: before.speed });
    // No spellcasting while shaped, even though her spellcasting data is untouched.
    expect(fight.reject(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] })).toEqual({ code: "unknownSpell" });
    const shapedOptions = turnOptions(fight.encounter, fight.state.characters["c-elspeth"], ruleset().content, ruleset().houseRules, "c-elspeth");
    expect(shapedOptions?.spells).toEqual([]);
    expect(shapedOptions?.wildShapeForms).toEqual([]);
    expect(shapedOptions?.canRevertShape).toBe(true);
    expect(fight.reject(sam, { kind: "combatWildShape", combatantId: "c-elspeth", monsterId: "monster:wolf" })).toEqual({ code: "alreadyShaped" });

    fight.run(sam, { kind: "combatWildShape", combatantId: "c-elspeth" });
    expect(fight.combatant("c-elspeth")).toMatchObject({ armorClass: before.armorClass, maxHp: before.maxHp, hp: before.hp, speed: before.speed, traits: before.traits });
    expect(fight.combatant("c-elspeth").wildShapeOriginal).toBeNull();
    expect(fight.reject(sam, { kind: "combatWildShape", combatantId: "c-elspeth" })).toEqual({ code: "notShaped" });
  });

  it("refuses Wild Shape without the feature", () => {
    const fight = elspethFirst();
    expect(fight.reject(sam, { kind: "combatWildShape", combatantId: "c-elspeth", monsterId: "monster:wolf" })).toEqual({ code: "unknownFeature" });
  });

  it("lets Cunning Action Dash as a bonus action, keeping the action free to attack with", () => {
    const base = newCampaign();
    const mira = base.characters["c-mira"];
    if (mira === undefined) throw new Error("fixture");
    const cunning = { ...base, characters: { ...base.characters, "c-mira": { ...mira, features: [...mira.features, "feature:cunning-action" as const] } } };
    const fight = startedFight(cunning);
    fight.run(alex, { kind: "combatDash", combatantId: "c-mira" });
    // Speed 30 twice (the turn's own movement, plus Dash's).
    expect(fight.combatant("c-mira").budget).toMatchObject({ action: true, bonusAction: false, movement: 60 });
    fight.run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    expect(fight.combatant("c-mira").budget.action).toBe(false);
  });

  it("still costs the action without Cunning Action, and never covers Dodge", () => {
    const base = newCampaign();
    const mira = base.characters["c-mira"];
    if (mira === undefined) throw new Error("fixture");
    const plain = startedFight(base);
    plain.run(alex, { kind: "combatDash", combatantId: "c-mira" });
    expect(plain.combatant("c-mira").budget).toMatchObject({ action: false, bonusAction: true });

    const cunning = { ...base, characters: { ...base.characters, "c-mira": { ...mira, features: [...mira.features, "feature:cunning-action" as const] } } };
    const dodging = startedFight(cunning);
    dodging.run(alex, { kind: "combatDodge", combatantId: "c-mira" });
    expect(dodging.combatant("c-mira").budget).toMatchObject({ action: false, bonusAction: true });
  });

  function withDivineSmite(): CampaignState {
    const base = newCampaign();
    const borin = base.characters["c-borin"];
    if (borin === undefined) throw new Error("fixture");
    const smiter = { ...borin, features: [...borin.features, "feature:divine-smite" as const], spellcasting: { ability: "cha" as const, spells: [], slots: { 1: 1 } } };
    return { ...base, characters: { ...base.characters, "c-borin": smiter } };
  }

  it("adds radiant damage from Divine Smite, spending the slot on a melee hit", () => {
    const fight = borinFirst(withDivineSmite());
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" });
    // Natural 20: certain hit. Longsword 1d8 (4) + Dueling (2) + STR (3); Smite 2d8 (3, 3).
    fight.rolls([20], [4, 3, 3]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword", smiteSlot: 1 });
    // 7 (weapon) + 6 (smite) against 7 max HP: downed.
    expect(fight.combatant("goblin-a").hp).toBe(0);
    expect(fight.combatant("c-borin").resources.spellSlots).toEqual({ 1: 0 });
  });

  it("refuses Divine Smite without the feature, or with no slot left", () => {
    const fight = borinFirst(newCampaign());
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" });
    expect(fight.reject(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword", smiteSlot: 1 })).toEqual({
      code: "unknownFeature",
    });

    const spent = withDivineSmite();
    const borin = spent.characters["c-borin"];
    if (borin === undefined) throw new Error("fixture");
    const noSlot = borinFirst({ ...spent, characters: { ...spent.characters, "c-borin": { ...borin, spellcasting: { ability: "cha", spells: [], slots: { 1: 0 } } } } });
    noSlot.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    noSlot.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" });
    expect(noSlot.reject(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword", smiteSlot: 1 })).toEqual({
      code: "noSpellSlot",
      slotLevel: 1,
    });
  });

  it("refuses Divine Smite on a ranged attack", () => {
    const base = newCampaign();
    const mira = base.characters["c-mira"];
    if (mira === undefined) throw new Error("fixture");
    const smiter = { ...mira, features: [...mira.features, "feature:divine-smite" as const], spellcasting: { ability: "cha" as const, spells: [], slots: { 1: 1 } } };
    const fight = startedFight({ ...base, characters: { ...base.characters, "c-mira": smiter } });
    expect(fight.reject(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow", smiteSlot: 1 })).toEqual({ code: "notMelee" });
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

  // A skeleton has no Nimble Escape, so retreating from melee to shoot risks
  // the attack it provokes; a player-controlled provoker gets a real choice
  // instead of taking it automatically (unlike an engine-played monster,
  // which still always takes it — see the Nimble Escape test above for the
  // other side of that same retreat-and-shoot tactic).
  function borinEngagedWithSkeleton(): Fight {
    const closeSkeleton: EncounterSpec = { ...close, monsters: [{ monsterId: "monster:skeleton", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] };
    const fight = new Fight().rolls([1, 20, 5]).run(organizer, { kind: "startEncounter", spec: closeSkeleton });
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "skeleton" });
    fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    return fight;
  }

  it("offers a hero the choice before a retreating skeleton draws its bow, rather than attacking for them", () => {
    const fight = borinEngagedWithSkeleton();
    expect(fight.encounter.pendingMove).toMatchObject({ combatantId: "skeleton", provokers: ["c-borin"] });
    expect(fight.encounter.pendingMove?.offer).not.toBeNull();
    expect(ofKind(fight, "resolutionDeclared")).toHaveLength(0);

    fight.rolls([15], [4]).run(jamie, { kind: "combatOpportunityAttack", combatantId: "c-borin", take: true });
    const opportunity = ofKind(fight, "resolutionDeclared").at(0);
    expect(opportunity?.resolution).toMatchObject({ actorId: "c-borin", purpose: "opportunity", targetIds: ["skeleton"] });
    expect(opportunity?.cost).toMatchObject({ reaction: true, action: false });
    expect(fight.combatant("c-borin").budget.reaction).toBe(false);
    expect(fight.encounter.pendingMove).toBeNull();
  });

  it("lets a hero decline the opportunity attack and hold the reaction", () => {
    const fight = borinEngagedWithSkeleton();
    fight.run(jamie, { kind: "combatOpportunityAttack", combatantId: "c-borin", take: false });
    expect(ofKind(fight, "resolutionDeclared").some((event) => event.resolution.actorId === "c-borin")).toBe(false);
    expect(fight.combatant("c-borin").budget.reaction).toBe(true);
    expect(fight.encounter.pendingMove).toBeNull();
  });

  it("declines the offer on its own once the window's timer runs out", () => {
    const fight = borinEngagedWithSkeleton();
    fight.run(system, { kind: "opportunityAttackTimerExpired", encounterId: fight.encounter.id, combatantId: "c-borin" });
    expect(ofKind(fight, "resolutionDeclared").some((event) => event.resolution.actorId === "c-borin")).toBe(false);
    expect(fight.combatant("c-borin").budget.reaction).toBe(true);
    expect(fight.encounter.pendingMove).toBeNull();
  });
});

describe("subclasses", () => {
  it("gives a Champion fighter a critical hit on a natural 19, not just a 20", () => {
    const base = newCampaign();
    const champion = { ...borin, features: [...borin.features, "feature:champion" as const] };
    const fight = new Fight({ ...base, characters: { ...base.characters, "c-borin": champion } })
      .rolls([1, 20, 5, 4])
      .run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(jamie, { kind: "combatMove", combatantId: "c-borin", zoneId: "courtyard" });
    fight.run(jamie, { kind: "combatEngage", combatantId: "c-borin", targetId: "goblin-a" });
    // Natural 19 + 5 (Str +3, proficiency +2) hits a goblin's AC 15 either
    // way; without Champion it would not also crit.
    fight.rolls([19], [5, 6]).run(jamie, { kind: "combatAttack", combatantId: "c-borin", targetId: "goblin-a", weapon: "item:longsword" });
    expect(ofKind(fight, "checkRolled").at(-1)).toMatchObject({ landed: true, critical: true });
    // 2d8 (5 + 6) + 3 Str = 14, off the goblin's 7 HP.
    expect(fight.combatant("goblin-a").hp).toBe(0);
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
    expect(ofKind(fight, "effectApplied").find((event) => event.combatantId === "c-mira")?.effect).toMatchObject({ definition: "condition:prone", conditions: ["condition:prone"] });
    const second = ofKind(fight, "resolutionDeclared")[1];
    expect(Object.values(second?.resolution.checks ?? {})[0]?.spec.mode).toBe("advantage");
    expect(fight.current).toBe("c-mira");
    expect(fight.combatant("c-mira")).toMatchObject({ effects: [], budget: { movement: 15 } });
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
