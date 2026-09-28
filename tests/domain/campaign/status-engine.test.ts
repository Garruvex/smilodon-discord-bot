import { describe, expect, it } from "vitest";

import type { EncounterSpec } from "../../../src/domain/campaign/commands/campaign-command.js";
import { turnOptions } from "../../../src/domain/campaign/combat/turn-rules.js";
import type { CampaignEvent } from "../../../src/domain/campaign/events/campaign-event.js";
import { replay } from "../../../src/domain/campaign/events/evolve.js";
import { damageMultiplier } from "../../../src/domain/campaign/rules/traits.js";
import { conditionLookup, forbiddenAttackTargets } from "../../../src/domain/campaign/effects/effect-queries.js";
import { alex, jamie, partyOfThree, organizer, ruleset, run, sam } from "./campaign-fixtures.js";
import { appliedCondition } from "./effect-fixtures.js";
import { Fight, skirmish, startedFight } from "./combat-fixtures.js";

const rules = ruleset();
const lookup = conditionLookup(rules.content);

function give(fight: Fight, combatantId: string, effect: ReturnType<typeof appliedCondition>): void {
  const event: CampaignEvent = { kind: "effectApplied", combatantId, effect };
  fight.state = replay(fight.state, [event]);
}

describe("damageMultiplier (resistance, immunity, vulnerability)", () => {
  it("halves resisted damage rounding down, zeroes immune damage, and doubles vulnerable damage", () => {
    expect(damageMultiplier([{ kind: "damageResistance", damageTypes: ["fire"] }], "fire")).toBe(0.5);
    expect(damageMultiplier([{ kind: "damageImmunity", damageTypes: ["poison"] }], "poison")).toBe(0);
    expect(damageMultiplier([{ kind: "damageVulnerability", damageTypes: ["bludgeoning"] }], "bludgeoning")).toBe(2);
    expect(damageMultiplier([], "fire")).toBe(1);
    expect(damageMultiplier([{ kind: "damageResistance", damageTypes: ["fire"] }], "cold")).toBe(1);
  });

  it("cancels resistance and vulnerability to the same type, per the SRD", () => {
    const traits = [{ kind: "damageResistance" as const, damageTypes: ["bludgeoning" as const] }, { kind: "damageVulnerability" as const, damageTypes: ["bludgeoning" as const] }];
    expect(damageMultiplier(traits, "bludgeoning")).toBe(1);
  });

  it("lets immunity win over vulnerability to the same type", () => {
    const traits = [{ kind: "damageImmunity" as const, damageTypes: ["poison" as const] }, { kind: "damageVulnerability" as const, damageTypes: ["poison" as const] }];
    expect(damageMultiplier(traits, "poison")).toBe(0);
  });
});

describe("Skeleton's bludgeoning vulnerability, wired through an actual attack", () => {
  const undead: EncounterSpec = { ...skirmish, monsters: [{ monsterId: "monster:skeleton", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] };

  function elspethFirst(): Fight {
    return new Fight(partyOfThree()).rolls([5, 4, 20, 3]).run(organizer, { kind: "startEncounter", spec: undead });
  }

  it("doubles a mace's bludgeoning damage against the skeleton", () => {
    const fight = elspethFirst();
    fight.run(sam, { kind: "combatMove", combatantId: "c-elspeth", zoneId: "courtyard" });
    fight.run(sam, { kind: "combatEngage", combatantId: "c-elspeth", targetId: "skeleton" });
    fight.rolls([15], [4]).run(sam, { kind: "combatAttack", combatantId: "c-elspeth", targetId: "skeleton", weapon: "item:mace" });
    // 4 rolled + 2 STR, doubled by the vulnerability: (4 + 2) * 2 = 12, off 13 max HP.
    expect(fight.combatant("skeleton").hp).toBe(1);
  });
});

describe("Charmed blocks attacking or targeting the charmer", () => {
  it("keeps the charmer off both turnOptions' target list and a direct attack, while another foe stays fair game", () => {
    const fight = new Fight(partyOfThree()).rolls([20, 4, 3, 2]).run(organizer, { kind: "startEncounter", spec: skirmish });
    give(fight, "c-mira", appliedCondition("condition:charmed", "goblin-a"));

    const options = turnOptions(fight.encounter, fight.state.characters["c-mira"], rules.content, rules.houseRules, "c-mira");
    const targets = options?.attacks.flatMap((attack) => attack.targetIds) ?? [];
    expect(targets).not.toContain("goblin-a");
    expect(targets).toContain("goblin-b");

    expect(fight.reject(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" })).toEqual({
      code: "invalidTarget",
    });
    fight.rolls([15], [4]).run(alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-b", weapon: "item:shortbow" });
    expect(fight.combatant("goblin-b").hp).toBeLessThan(7);
  });

  it("computes forbiddenAttackTargets directly off the effect's sourceId, not the condition's name", () => {
    const holder = { effects: [appliedCondition("condition:charmed", "the-charmer")], condition: "active" as const, dodging: false, disengaged: false, speed: 30, budget: { reaction: true } };
    expect(forbiddenAttackTargets(holder, lookup)).toEqual(["the-charmer"]);
  });
});

describe("a turn timer firing mid-resolution retries instead of dropping the timeout", () => {
  it("re-arms a fresh combatTurn timer, and leaves the pending attack and the away policy untouched", () => {
    const fight = startedFight();
    // Declared directly (not through Fight.run), so the to-hit roll it
    // asked for is left unanswered: the turn is genuinely mid-resolution.
    const attacking = run(fight.state, alex, { kind: "combatAttack", combatantId: "c-mira", targetId: "goblin-a", weapon: "item:shortbow" }, { now: 1_000 });
    const encounter = attacking.state.encounter;
    if (encounter === null) throw new Error("fixture");
    expect(encounter.resolution).not.toBeNull();

    const timedOut = run(attacking.state, { kind: "system" }, { kind: "turnTimerExpired", encounterId: encounter.id, turnNumber: encounter.turnNumber }, { now: 2_000 });
    expect(timedOut.events).toEqual([]); // Busy: nothing about the fight itself changed.
    expect(timedOut.requests).toEqual([
      { kind: "startTimer", timer: { kind: "combatTurn", timerId: `turn:${encounter.id}:${encounter.turnNumber}`, dueAt: 7_000, encounterId: encounter.id, turnNumber: encounter.turnNumber } },
    ]);
    // Still mira's turn, still waiting on her attack roll — the away policy did not run in her place.
    expect(timedOut.state.encounter?.resolution).not.toBeNull();
    expect(timedOut.state.encounter?.order[timedOut.state.encounter.turnIndex]).toBe("c-mira");
  });
});

describe("automated movement respects immobilizing conditions", () => {
  const spiderPit: EncounterSpec = { ...skirmish, monsters: [{ monsterId: "monster:giant-wolf-spider", zoneId: "courtyard", npcId: null, fleeBelowHpFraction: null }] };

  it("keeps a restrained spider from closing the distance on its own turn", () => {
    // Heroes act first; the spider (lowest initiative) moves last.
    const fight = new Fight(partyOfThree()).rolls([20, 15, 10, 1]).run(organizer, { kind: "startEncounter", spec: spiderPit });
    give(fight, "giant-wolf-spider", appliedCondition("condition:restrained", "test-source"));
    expect(fight.combatant("giant-wolf-spider").zoneId).toBe("courtyard");

    fight.run(alex, { kind: "combatDodge", combatantId: "c-mira" });
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" });
    fight.run(jamie, { kind: "combatDodge", combatantId: "c-borin" });
    fight.run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    fight.run(sam, { kind: "combatDodge", combatantId: "c-elspeth" });
    fight.run(sam, { kind: "endTurn", combatantId: "c-elspeth" });

    // The spider's own turn just played out automatically (a monster turn
    // needs no player command): restrained, it could not approach at all.
    expect(fight.combatant("giant-wolf-spider").zoneId).toBe("courtyard");
  });
});
