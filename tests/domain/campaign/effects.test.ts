import { describe, expect, it } from "vitest";

import type { Combatant } from "../../../src/domain/campaign/combat/combat-state.js";
import { turnOptions } from "../../../src/domain/campaign/combat/turn-rules.js";
import type { EffectInstance } from "../../../src/domain/campaign/effects/effect-instance.js";
import {
  attackBias,
  autoFailsSave,
  bonusDiceFor,
  canAct,
  canReact,
  conditionLookup,
  conditionsOf,
  effectsDueAt,
  hasCondition,
  hitsAreCritical,
  saveBias,
  speedOf,
} from "../../../src/domain/campaign/effects/effect-queries.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import { replay } from "../../../src/domain/campaign/events/evolve.js";
import type { ContentId } from "../../../src/domain/campaign/rules/content-id.js";
import { alex, jamie, organizer, partyOfThree, ruleset, sam } from "./campaign-fixtures.js";
import { Fight, skirmish, startedFight } from "./combat-fixtures.js";
import { appliedCondition } from "./effect-fixtures.js";

const rules = ruleset();
const lookup = conditionLookup(rules.content);

// A creature from a started fight, with the given effects laid on it.
function withEffects(fight: Fight, id: string, effects: readonly EffectInstance[], patch: Partial<Combatant> = {}): Combatant {
  return { ...fight.combatant(id), ...patch, effects };
}

function give(fight: Fight, combatantId: string, effect: EffectInstance): void {
  const event: CampaignEvent = { kind: "effectApplied", combatantId, effect };
  fight.state = replay(fight.state, [event]);
}

const condition = (id: string, sourceId = "test-source"): EffectInstance => appliedCondition(id as ContentId<"condition">, sourceId);

describe("what conditions are", () => {
  it("brings the conditions a condition includes, and treats a downed creature as unconscious", () => {
    const fight = startedFight();
    const mira = fight.combatant("c-mira");
    expect(conditionsOf(mira, lookup)).toEqual([]);
    expect(conditionsOf(withEffects(fight, "c-mira", [condition("condition:unconscious")]), lookup)).toEqual(["condition:unconscious", "condition:incapacitated", "condition:prone"]);
    // Being at 0 HP is enough: nothing has to be applied.
    const downed = withEffects(fight, "c-mira", [], { condition: "unconscious" });
    expect(hasCondition(downed, "condition:prone", lookup)).toBe(true);
    expect(hasCondition({ ...downed, condition: "stable" }, "condition:incapacitated", lookup)).toBe(true);
    expect(hasCondition({ ...downed, condition: "dead" }, "condition:prone", lookup)).toBe(false);
  });

  it("does not stack a condition, replaces from the same source, and lets others coexist", () => {
    const fight = startedFight();
    give(fight, "c-mira", condition("condition:poisoned", "spider-a"));
    give(fight, "c-mira", condition("condition:poisoned", "spider-b"));
    expect(fight.combatant("c-mira").effects).toHaveLength(1);
    const replacing = (source: string, id: string): EffectInstance => ({ ...condition("condition:blinded", source), id, stacking: "replace" });
    give(fight, "c-borin", replacing("a", "one"));
    give(fight, "c-borin", replacing("a", "two"));
    give(fight, "c-borin", replacing("b", "three"));
    expect(fight.combatant("c-borin").effects.map((effect) => effect.id)).toEqual(["two", "three"]);
    const together = (id: string): EffectInstance => ({ ...condition("condition:frightened", "x"), id, stacking: "coexist" });
    give(fight, "c-mira", together("f1"));
    give(fight, "c-mira", together("f2"));
    expect(fight.combatant("c-mira").effects.filter((effect) => effect.definition === "condition:frightened")).toHaveLength(2);
  });
});

describe("acting and moving", () => {
  it("stops an incapacitated creature from acting or reacting", () => {
    const fight = startedFight();
    const mira = fight.combatant("c-mira");
    expect(canAct(mira, lookup)).toBe(true);
    expect(canReact(mira, lookup)).toBe(true);
    const stunned = withEffects(fight, "c-mira", [condition("condition:incapacitated")]);
    expect(canAct(stunned, lookup)).toBe(false);
    expect(canReact(stunned, lookup)).toBe(false);
    // A creature that has used its reaction cannot react either.
    expect(canReact({ ...mira, budget: { ...mira.budget, reaction: false } }, lookup)).toBe(false);
  });

  it("holds a grappled or restrained creature in place", () => {
    const fight = startedFight();
    expect(speedOf(fight.combatant("c-mira"), lookup)).toBe(30);
    for (const held of ["condition:grappled", "condition:restrained"]) {
      expect(speedOf(withEffects(fight, "c-mira", [condition(held)]), lookup)).toBe(0);
    }
  });

  it("refuses moving, closing in and withdrawing while held, and leaves them out of the options", () => {
    const fight = startedFight();
    give(fight, "c-mira", condition("condition:grappled", "goblin-a"));
    expect(fight.reject(alex, { kind: "combatMove", combatantId: "c-mira", zoneId: "courtyard" })).toEqual({ code: "notEnoughMovement", needed: 20, left: 0 });
    const options = turnOptions(fight.state.encounter, fight.state.characters["c-mira"], rules.content, rules.houseRules, "c-mira");
    expect(options?.moves).toEqual([]);
    // Still able to fight: grappled costs speed, not actions.
    expect(options?.canTakeAction).toBe(true);
  });

  it("makes an incapacitated hero lose the turn", () => {
    const fight = startedFight();
    give(fight, "c-borin", condition("condition:incapacitated", "goblin-a"));
    const before = fight.events.length;
    fight.rolls([3, 3, 3, 3], [1, 1]).run(alex, { kind: "endTurn", combatantId: "c-mira" });
    const after = fight.events.slice(before).map((event) => (event.kind === "turnStarted" || event.kind === "turnEnded" ? `${event.kind}:${event.combatantId}` : event.kind));
    const started = after.indexOf("turnStarted:c-borin");
    expect(started).toBeGreaterThan(-1);
    // Borin's turn starts and ends with nothing in between: no menu, no timer wait.
    expect(after.slice(started, started + 2)).toEqual(["turnStarted:c-borin", "turnEnded:c-borin"]);
  });
});

describe("rolls", () => {
  const fight = startedFight();
  const mira = fight.combatant("c-mira");
  const goblin = fight.combatant("goblin-a");
  const modes = (attacker: Combatant, target: Combatant, within5: boolean): [number, number] => {
    const bias = attackBias(attacker, target, lookup, within5);
    return [bias.advantage, bias.disadvantage];
  };
  const on = (base: Combatant, ...ids: string[]): Combatant => ({ ...base, effects: ids.map((id) => condition(id)) });

  it("gives attacks against a prone creature advantage up close and disadvantage from afar", () => {
    expect(modes(mira, on(goblin, "condition:prone"), true)).toEqual([1, 0]);
    expect(modes(mira, on(goblin, "condition:prone"), false)).toEqual([0, 1]);
  });

  it("counts an unconscious target as advantage everywhere, and prone on top of it", () => {
    expect(modes(mira, on(goblin, "condition:unconscious"), true)).toEqual([2, 0]);
    expect(modes(mira, on(goblin, "condition:unconscious"), false)).toEqual([1, 1]);
  });

  it("gives disadvantage to the attacks of a poisoned, frightened, blinded, restrained or prone creature", () => {
    for (const held of ["condition:poisoned", "condition:frightened", "condition:blinded", "condition:restrained", "condition:prone"]) {
      expect(modes(on(mira, held), goblin, true)).toEqual([0, 1]);
    }
  });

  it("gives attacks against a blinded or restrained creature advantage", () => {
    for (const held of ["condition:blinded", "condition:restrained"]) expect(modes(mira, on(goblin, held), false)).toEqual([1, 0]);
  });

  it("counts a dodging creature as disadvantage against it, only while it can act", () => {
    expect(modes(mira, { ...goblin, dodging: true }, true)).toEqual([0, 1]);
    expect(modes(mira, { ...goblin, dodging: true, condition: "dead" }, true)).toEqual([0, 0]);
  });

  it("names where each bias comes from, so a menu can say why", () => {
    const reasons = attackBias(on(mira, "condition:poisoned"), on(goblin, "condition:restrained"), lookup, true).reasons;
    expect(reasons).toEqual([
      { source: "condition:poisoned", mode: "disadvantage" },
      { source: "condition:restrained", mode: "advantage" },
    ]);
  });

  it("gives a restrained creature disadvantage on Dexterity saves only, and makes an unconscious one fail Strength and Dexterity", () => {
    const restrained = on(goblin, "condition:restrained");
    expect(saveBias(restrained, "dex", lookup).disadvantage).toBe(1);
    expect(saveBias(restrained, "con", lookup).disadvantage).toBe(0);
    const out = on(goblin, "condition:unconscious");
    expect([autoFailsSave(out, "str", lookup), autoFailsSave(out, "dex", lookup), autoFailsSave(out, "con", lookup)]).toEqual([true, true, false]);
  });

  it("makes a close hit on an unconscious creature critical, and no other", () => {
    const out = on(goblin, "condition:unconscious");
    expect(hitsAreCritical(out, lookup, true)).toBe(true);
    expect(hitsAreCritical(out, lookup, false)).toBe(false);
    expect(hitsAreCritical(on(goblin, "condition:prone"), lookup, true)).toBe(false);
  });

  it("collects the bonus dice an effect adds", () => {
    const blessed: EffectInstance = {
      ...condition("condition:poisoned"),
      definition: "spell:bless",
      conditions: [],
      modifiers: [{ kind: "bonusDie", die: { terms: [{ count: 1, sides: 4 }], modifier: 0 }, appliesTo: ["attack"], source: "spell:bless" }],
    };
    expect(bonusDiceFor({ effects: [blessed] }, "attack")).toHaveLength(1);
    expect(bonusDiceFor({ effects: [blessed] }, "save")).toEqual([]);
  });
});

describe("in a fight", () => {
  it("shoots with disadvantage while restrained, and with advantage at a restrained foe", () => {
    const restrainedHero = startedFight();
    give(restrainedHero, "c-mira", condition("condition:restrained", "goblin-a"));
    restrainedHero.rolls([12], [1]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const first = restrainedHero.events.filter((event) => event.kind === "resolutionDeclared").at(-1);
    // Restrained gives disadvantage; the restrained hero is also easier to hit, but that is the goblins' roll.
    expect(first?.kind === "resolutionDeclared" ? Object.values(first.resolution.checks)[0]?.spec.mode : null).toBe("disadvantage");

    const restrainedFoe = startedFight();
    give(restrainedFoe, "goblin-a", condition("condition:restrained", "c-mira"));
    restrainedFoe.rolls([12], [1]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" });
    const second = restrainedFoe.events.filter((event) => event.kind === "resolutionDeclared").at(-1);
    expect(second?.kind === "resolutionDeclared" ? Object.values(second.resolution.checks)[0]?.spec.mode : null).toBe("advantage");
  });

  it("lets an unconscious foe fail a Dexterity save without a roll", () => {
    const fight = new Fight(partyOfThree()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    give(fight, "goblin-a", condition("condition:unconscious", "c-elspeth"));
    fight.rolls([], [6]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
    // No saving throw was rolled, and the flame landed.
    expect(fight.events.some((event) => event.kind === "checkRolled")).toBe(false);
    expect(fight.combatant("goblin-a").hp).toBeLessThan(7);
  });

  it("does not let an unconscious creature avoid a spell it would have saved against, when it is conscious", () => {
    const fight = new Fight(partyOfThree()).rolls([5, 4, 20, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.rolls([15]).run(sam, { kind: "combatCast", combatantId: "c-elspeth", spellId: "spell:sacred-flame", slotLevel: 0, targetIds: ["goblin-a"] });
    expect(fight.events.some((event) => event.kind === "checkRolled" && !event.landed)).toBe(true);
    expect(fight.combatant("goblin-a").hp).toBe(7);
  });
});

describe("how long an effect lasts", () => {
  const clocked = (follows: "source" | "target", boundary: "start" | "end", untilRound: number, sourceId = "c-mira"): EffectInstance => ({
    ...condition("condition:poisoned", sourceId),
    clock: { follows, boundary, untilRound },
  });
  const creatures = [
    { id: "c-mira", effects: [] as readonly EffectInstance[] },
    { id: "goblin-a", effects: [clocked("source", "start", 3), clocked("target", "end", 2)] },
  ];

  it("follows the source's turn or the holder's, at the named boundary, from the named round on", () => {
    const due = (creatureId: string, boundary: "start" | "end", round: number): string[] =>
      effectsDueAt(creatures, creatureId, boundary, round).flatMap(({ effects }) => effects.map((effect) => effect.clock?.follows ?? ""));
    expect(due("c-mira", "start", 2)).toEqual([]);
    expect(due("c-mira", "start", 3)).toEqual(["source"]);
    expect(due("c-mira", "end", 3)).toEqual([]);
    expect(due("goblin-a", "end", 1)).toEqual([]);
    expect(due("goblin-a", "end", 2)).toEqual(["target"]);
    expect(due("goblin-a", "start", 5)).toEqual([]);
  });

  it("ends when its clock runs out during play, and not before", () => {
    const fight = startedFight();
    // Follows Borin's own turn and ends at the end of it in round 2.
    give(fight, "c-borin", clocked("target", "end", 2, "goblin-a"));
    const removals = (): string[] => fight.events.flatMap((event) => (event.kind === "effectsRemoved" ? [`${event.combatantId}:${event.reason}`] : []));
    const finishTurns = (round: number): void => {
      for (let step = 0; step < 12 && fight.encounter.round === round; step += 1) {
        const id = fight.current ?? "";
        const owner = fight.state.characters[id]?.ownerUserId === "u-jamie" ? jamie : alex;
        if (id === "c-mira" || id === "c-borin") fight.run(owner, { kind: "combatDodge", combatantId: id }).run(owner, { kind: "endTurn", combatantId: id });
        else fight.rolls([2, 2, 2], [1, 1]).run(organizer, { kind: "turnTimerExpired", encounterId: "enc-1", turnNumber: fight.encounter.turnNumber });
      }
    };
    finishTurns(1);
    expect(fight.combatant("c-borin").effects).toHaveLength(1);
    expect(removals()).toEqual([]);
    finishTurns(2);
    expect(fight.combatant("c-borin").effects).toEqual([]);
    expect(removals()).toEqual(["c-borin:expired"]);
  });
});
