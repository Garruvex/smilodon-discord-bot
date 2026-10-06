import { describe, expect, it } from "vitest";

import type { Actor, CampaignCommand } from "../../../src/domain/campaign/commands/campaign-command.js";
import { turnOptions } from "../../../src/domain/campaign/combat/turn-rules.js";
import { decide } from "../../../src/domain/campaign/engine/decide.js";
import { replay } from "../../../src/domain/campaign/events/evolve.js";
import type { SealedRuleset } from "../../../src/domain/campaign/rules/ruleset.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, newCampaign, organizer, partyOfThree, ruleset, sam } from "./campaign-fixtures.js";
import { Fight, skirmish, startedFight } from "./combat-fixtures.js";

// The menu and the engine must agree (docs/dnd-engine-architecture.md §4): for
// the hero whose turn it is, every command anyone could send is accepted by the
// engine exactly when turnOptions lists it. This tries them all.

const owners: Record<string, Actor> = { "c-mira": alex, "c-borin": jamie, "c-elspeth": sam };

interface Attempt {
  readonly label: string;
  readonly command: CampaignCommand;
  // Whether turnOptions says this command is legal.
  readonly listed: boolean;
}

function attempts(state: CampaignState, rules: SealedRuleset, heroId: string): Attempt[] {
  const options = turnOptions(state.encounter, state.characters[heroId], rules.content, rules.houseRules, heroId);
  const encounter = state.encounter;
  const hero = encounter?.combatants[heroId];
  if (options === null || encounter === null || hero === undefined) throw new Error(`No turn options for ${heroId}.`);
  const list: Attempt[] = [];
  const everyone = Object.keys(encounter.combatants);

  for (const attack of hero.attacks) {
    for (const targetId of everyone) {
      const listed = options.attacks.some((entry) => entry.option.weapon === attack.weapon && entry.targetIds.includes(targetId));
      list.push({ label: `attack ${attack.weapon} at ${targetId}`, command: { kind: "combatAttack", combatantId: heroId, targetId, weapon: attack.weapon }, listed });
    }
  }
  for (const spellId of hero.spellcasting?.spells ?? []) {
    const entry = options.spells.find((candidate) => candidate.spell.id === spellId);
    for (const slotLevel of [0, 1, 2, 3]) {
      for (const targetId of everyone) {
        const listed = entry !== undefined && entry.slotLevels.includes(slotLevel) && entry.targetIds.includes(targetId) && (entry.spell.targeting.relation !== "self" || targetId === heroId);
        list.push({ label: `cast ${spellId} at level ${slotLevel} on ${targetId}`, command: { kind: "combatCast", combatantId: heroId, spellId, slotLevel, targetIds: [targetId] }, listed });
      }
    }
  }
  for (const featureId of hero.features) {
    list.push({ label: `feature ${featureId}`, command: { kind: "combatUseFeature", combatantId: heroId, featureId }, listed: options.features.some((entry) => entry.feature.id === featureId) });
  }
  for (const itemId of state.characters[heroId]?.equipment ?? []) {
    list.push({ label: `use ${itemId}`, command: { kind: "combatUseItem", combatantId: heroId, itemId }, listed: options.potions.some((entry) => entry.itemId === itemId) });
    for (const on of [true, false]) {
      const shield = options.shields.find((entry) => entry.itemId === itemId);
      list.push({ label: `shield ${itemId} ${on ? "on" : "off"}`, command: { kind: "combatShield", combatantId: heroId, itemId, on }, listed: shield !== undefined && shield.canSwitch && shield.on !== on });
    }
  }
  for (const zone of encounter.zones) {
    list.push({ label: `move to ${zone.id}`, command: { kind: "combatMove", combatantId: heroId, zoneId: zone.id }, listed: options.moves.some((entry) => entry.zoneId === zone.id) });
  }
  for (const targetId of everyone) {
    list.push({ label: `engage ${targetId}`, command: { kind: "combatEngage", combatantId: heroId, targetId }, listed: options.engage.includes(targetId) });
  }
  list.push({ label: "withdraw", command: { kind: "combatWithdraw", combatantId: heroId }, listed: options.canWithdraw });
  for (const kind of ["combatDash", "combatDodge", "combatDisengage"] as const) {
    list.push({ label: kind, command: { kind, combatantId: heroId }, listed: options.canTakeAction });
  }
  return list;
}

// Every attempt whose acceptance by the engine differs from the option list.
function disagreements(state: CampaignState, rules: SealedRuleset, heroId: string): string[] {
  const actor = owners[heroId];
  if (actor === undefined) throw new Error(`No owner for ${heroId}.`);
  return attempts(state, rules, heroId).flatMap((attempt) => {
    const result = decide(state, attempt.command, { rules, now: 0, actor });
    const accepted = result.kind !== "rejected";
    return accepted === attempt.listed ? [] : [`${attempt.label}: engine ${accepted ? "accepts" : `refuses (${result.kind === "rejected" ? result.rejection.code : ""})`}, options ${attempt.listed ? "list it" : "omit it"}`];
  });
}

const rules = ruleset();

describe("turn options and the engine agree", () => {
  it("at the start of a fight, for the rogue", () => {
    const fight = startedFight();
    expect(fight.current).toBe("c-mira");
    expect(disagreements(fight.state, rules, "c-mira")).toEqual([]);
  });

  it("after closing in, engaging, and spending the action", () => {
    const fight = startedFight();
    fight.run(alex, { kind: "combatMove", combatantId: "c-mira", zoneId: "courtyard" });
    expect(disagreements(fight.state, rules, "c-mira")).toEqual([]);
    fight.run(alex, { kind: "combatEngage", combatantId: "c-mira", targetId: "goblin-a" });
    expect(disagreements(fight.state, rules, "c-mira")).toEqual([]);
    fight.rolls([2], [1]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortsword" });
    expect(disagreements(fight.state, rules, "c-mira")).toEqual([]);
    expect(turnOptions(fight.state.encounter, fight.state.characters["c-mira"], rules.content, rules.houseRules, "c-mira")?.canTakeAction).toBe(false);
  });

  it("for the fighter, with a shield to switch", () => {
    const fight = startedFight();
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    // The goblins act, then it is Borin's turn.
    for (let step = 0; step < 6 && fight.current !== "c-borin"; step += 1) fight.rolls([3], [1]).run(organizer, { kind: "turnTimerExpired", encounterId: "enc-1", turnNumber: fight.encounter.turnNumber });
    expect(fight.current).toBe("c-borin");
    expect(disagreements(fight.state, rules, "c-borin")).toEqual([]);
  });

  it("for a cleric with spell slots, then with none left", () => {
    const fight = new Fight(partyOfThree()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    expect(fight.current).toBe("c-elspeth");
    expect(disagreements(fight.state, rules, "c-elspeth")).toEqual([]);
    fight.run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:bless", slotLevel: 1, targetIds: ["c-elspeth", "c-mira", "c-borin"] });
    expect(disagreements(fight.state, rules, "c-elspeth")).toEqual([]);
    const drained: CampaignState = {
      ...fight.state,
      encounter: fight.state.encounter === null ? null : { ...fight.state.encounter, combatants: { ...fight.state.encounter.combatants, "c-elspeth": { ...fight.encounter.combatants["c-elspeth"]!, resources: { spellSlots: { 1: 0 }, featureUses: {} } } } },
    };
    expect(disagreements(drained, rules, "c-elspeth")).toEqual([]);
  });

  it("with a potion in the pack, under both house rules for its cost", () => {
    for (const cost of ["action", "bonus-action"]) {
      const base = newCampaign();
      const mira = base.characters["c-mira"];
      if (mira === undefined) throw new Error("mira");
      const state: CampaignState = { ...base, characters: { ...base.characters, "c-mira": { ...mira, equipment: [...mira.equipment, "item:potion-of-healing"] } } };
      const houseRules = ruleset({ "healing-potion-cost": cost });
      const fight = new Fight(state, houseRules).rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
      expect(disagreements(fight.state, houseRules, "c-mira")).toEqual([]);
      expect(turnOptions(fight.state.encounter, fight.state.characters["c-mira"], houseRules.content, houseRules.houseRules, "c-mira")?.potions).toEqual([{ itemId: "item:potion-of-healing", count: 1, bonusAction: cost === "bonus-action" }]);
    }
  });

  it("offers nothing while an attack is still being resolved", () => {
    const fight = startedFight();
    const declared = decide(fight.state, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" }, { rules, now: 0, actor: alex });
    if (declared.kind === "rejected") throw new Error("attack");
    const busy = replay(fight.state, declared.events);
    const options = turnOptions(busy.encounter, busy.characters["c-mira"], rules.content, rules.houseRules, "c-mira");
    expect(options?.busy).toBe(true);
    expect([options?.attacks, options?.spells, options?.moves, options?.engage].map((entry) => entry?.length)).toEqual([0, 0, 0, 0]);
    expect(disagreements(busy, rules, "c-mira")).toEqual([]);
  });

  it("gives nobody options when it is not their turn or they are down", () => {
    const fight = startedFight();
    expect(turnOptions(fight.state.encounter, fight.state.characters["c-borin"], rules.content, rules.houseRules, "c-borin")).toBeNull();
    expect(turnOptions(fight.state.encounter, fight.state.characters["c-mira"], rules.content, rules.houseRules, "goblin-a")).toBeNull();
    expect(turnOptions(null, undefined, rules.content, rules.houseRules, "c-mira")).toBeNull();
  });
});
