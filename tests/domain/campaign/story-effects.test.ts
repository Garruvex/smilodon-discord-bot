import { describe, expect, it } from "vitest";

import type { EncounterSpec, PlannedEffect, RoundPlanProposal } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, d20Roll, jamie, kinds, newCampaign, organizer, reject, run, system } from "./campaign-fixtures.js";
import { replay } from "../../../src/domain/campaign/events/evolve.js";
import { Fight, skirmish } from "./combat-fixtures.js";

const ambush: EncounterSpec = { ...skirmish, id: "encounter:gate-ambush" };

const toChapel: PlannedEffect = { effect: { kind: "transitionScene", sceneId: "scene:ruined-chapel" }, when: { kind: "always" } };
const ambushIfSpotted: PlannedEffect = {
  effect: { kind: "startEncounter", encounter: ambush },
  when: { kind: "checkOutcome", characterId: "c-mira", success: false },
};

function sneaking(effects: readonly PlannedEffect[]): RoundPlanProposal {
  return {
    roundNumber: 1,
    actions: [
      { characterId: "c-mira", resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "medium", rollModeReasons: [] } },
    ],
    effects,
  };
}

// Round 1: Mira sneaks, Borin passes; the Planner's proposal is next.
function closedRound(state: CampaignState = newCampaign()): CampaignState {
  let next = run(state, system, { kind: "openRound" }).state;
  next = run(next, alex, { kind: "submitAction", characterId: "c-mira", text: "I sneak into the chapel." }).state;
  return run(next, jamie, { kind: "pass", characterId: "c-borin" }).state;
}

// Mira clicks Roll; her Stealth (+7) lands against DC 15 with the given d20.
function rollStealth(state: CampaignState, d20: number): ReturnType<typeof run> {
  const rolling = run(state, alex, { kind: "requestRoll", checkId: "r1:c-mira" }).state;
  return run(rolling, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll: d20Roll("normal", [d20], 7) } });
}

describe("story effects", () => {
  it("moves the scene and queues the fight on a failed check, then starts it after narration", () => {
    const planned = run(closedRound(), system, { kind: "applyRoundPlan", proposal: sneaking([ambushIfSpotted, toChapel]) }).state;
    expect(planned.round?.effects).toHaveLength(2);

    const failed = rollStealth(planned, 3);
    // Scene first, then the fight, then the round resolves for narration.
    expect(kinds(failed.events)).toEqual(["checkResolved", "sceneTransitioned", "encounterQueued", "roundResolved"]);
    expect(failed.state.sceneId).toBe("scene:ruined-chapel");
    expect(failed.state.pendingEncounter?.id).toBe("encounter:gate-ambush");
    expect(failed.requests).toContainEqual({ kind: "narrate", roundNumber: 1 });

    const narrated = run(failed.state, system, { kind: "recordNarration", roundNumber: 1, text: "A goblin spots Mira!" });
    expect(kinds(narrated.events)).toEqual(["narrationRecorded", "encounterStarted"]);
    expect(narrated.state.pendingEncounter).toBeNull();
    expect(narrated.state.encounterHistory).toEqual(["encounter:gate-ambush"]);
    expect(narrated.state.round).toBeNull();
  });

  it("skips an effect whose check went the other way", () => {
    const planned = run(closedRound(), system, { kind: "applyRoundPlan", proposal: sneaking([ambushIfSpotted]) }).state;
    const succeeded = rollStealth(planned, 15);
    expect(kinds(succeeded.events)).toEqual(["checkResolved", "roundResolved"]);
    const narrated = run(succeeded.state, system, { kind: "recordNarration", roundNumber: 1, text: "Mira slips inside unseen." });
    expect(kinds(narrated.events)).toEqual(["narrationRecorded", "roundOpened"]);
  });

  it("refuses effects that do not fit the round, listing every problem", () => {
    const orphan: PlannedEffect = { ...ambushIfSpotted, when: { kind: "checkOutcome", characterId: "c-borin", success: false } };
    const broken: PlannedEffect = {
      effect: { kind: "startEncounter", encounter: { ...ambush, id: "encounter:other", monsters: [{ ...ambush.monsters[0]!, monsterId: "monster:dragon" }] } },
      when: { kind: "always" },
    };
    const rejection = reject(closedRound(), system, { kind: "applyRoundPlan", proposal: sneaking([orphan, broken, toChapel, toChapel]) });
    expect(rejection).toEqual({
      code: "invalidPlan",
      problems: [
        "Only one scene transition per round.",
        "Only one encounter per round.",
        "startEncounter depends on c-borin, who has no check this round.",
        "Encounter encounter:other: Unknown monster monster:dragon.",
      ],
    });
  });

  it("runs each encounter only once", () => {
    const fought = { ...newCampaign(), encounterHistory: ["encounter:gate-ambush"] };
    const always: PlannedEffect = { ...ambushIfSpotted, when: { kind: "always" } };
    expect(reject(closedRound(fought), system, { kind: "applyRoundPlan", proposal: sneaking([always]) })).toEqual({
      code: "invalidPlan",
      problems: ["Encounter encounter:gate-ambush: This encounter has already been fought."],
    });
    expect(reject(fought, organizer, { kind: "startEncounter", spec: ambush })).toMatchObject({ code: "invalidEncounter" });
  });

  it("starts a queued fight on continue when its round was narrated while everyone was away", () => {
    const planned = run(closedRound(), system, { kind: "applyRoundPlan", proposal: sneaking([ambushIfSpotted]) }).state;
    let state = rollStealth(planned, 3).state;
    state = run(state, organizer, { kind: "markAway", userId: "u-alex" }).state;
    state = run(state, organizer, { kind: "markAway", userId: "u-jamie" }).state;
    expect(state.status).toBe("waitingForPlayers");
    state = run(state, system, { kind: "recordNarration", roundNumber: 1, text: "A goblin spots Mira!" }).state;
    expect(state.encounter).toBeNull();
    state = run(state, organizer, { kind: "markReturned", userId: "u-alex" }).state;
    const resumed = run(state, alex, { kind: "continue" });
    expect(kinds(resumed.events)).toEqual(["resumed", "encounterStarted"]);
  });
});

describe("combat narration", () => {
  // Initiative: Mira 20, Borin 15, goblins 5 and 4; every attack misses (d20 2).
  function roundTwo(): Fight {
    const fight = new Fight().rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" }).rolls([2, 2]).run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    return fight;
  }

  it("asks for a flourish when a round ends, never for the round in progress", () => {
    const fight = roundTwo();
    expect(fight.encounter.round).toBe(2);
    expect(fight.requests).toContainEqual({ kind: "narrateCombat", encounterId: "enc-1", round: 1, final: false });
    expect(fight.reject(system, { kind: "recordCombatNarration", encounterId: "enc-1", round: 2, text: "Too soon." })).toEqual({ code: "staleNarration" });
    expect(fight.reject(alex, { kind: "recordCombatNarration", encounterId: "enc-1", round: 1, text: "Mine." })).toEqual({ code: "systemOnly" });

    fight.run(system, { kind: "recordCombatNarration", encounterId: "enc-1", round: 1, text: " Arrows whistle past. " });
    expect(fight.events.at(-1)).toEqual({ kind: "combatNarrationRecorded", round: 1, text: "Arrows whistle past.", final: false });
    expect(fight.requests.at(-1)).toEqual({ kind: "deliver", delivery: { kind: "combatNarration", encounterId: "enc-1", round: 1 } });
    expect(fight.encounter.narratedRound).toBe(1);
    // Turns never waited for it, and a repeat is dropped.
    expect(fight.reject(system, { kind: "recordCombatNarration", encounterId: "enc-1", round: 1, text: "Again." })).toEqual({ code: "staleNarration" });
  });

  it("closes the fight with narration that opens the next exploration round", () => {
    const fight = roundTwo();
    // Everyone else flees the field: the goblins break at their next turn.
    const beaten = { ...fight.state };
    const encounter = fight.encounter;
    fight.state = {
      ...beaten,
      encounter: {
        ...encounter,
        combatants: Object.fromEntries(
          Object.entries(encounter.combatants).map(([id, combatant]) => [id, combatant.side === "foes" ? { ...combatant, fleeBelowHpFraction: 0.99, hp: 1 } : combatant]),
        ),
      },
    };
    fight.run(alex, { kind: "endTurn", combatantId: "c-mira" }).run(jamie, { kind: "endTurn", combatantId: "c-borin" });
    expect(fight.encounter.status).toBe("ended");
    expect(fight.requests).toContainEqual({ kind: "narrateCombat", encounterId: "enc-1", round: 2, final: true });

    fight.run(system, { kind: "recordCombatNarration", encounterId: "enc-1", round: 2, text: "The goblins scatter into the night." });
    expect(fight.kinds().slice(-2)).toEqual(["combatNarrationRecorded", "roundOpened"]);
    expect(fight.events.at(-2)).toMatchObject({ final: true });
    // The unnarrated round 1 flourish arriving late is dropped.
    expect(fight.reject(system, { kind: "recordCombatNarration", encounterId: "enc-1", round: 1, text: "Late." })).toEqual({ code: "staleNarration" });
  });
});

describe("after a fight", () => {
  it("brings heroes at 0 HP back with 1 HP after a victory, but not after a defeat", () => {
    const won = new Fight().rolls([20, 15, 5, 4]).run(organizer, { kind: "startEncounter", spec: skirmish });
    const fought = won.encounter;
    const downed = {
      ...fought,
      combatants: Object.fromEntries(
        Object.entries(fought.combatants).map(([id, combatant]) => [id, id === "c-borin" ? { ...combatant, hp: 0, condition: "unconscious" as const } : combatant]),
      ),
    };
    const ended = (outcome: "victory" | "defeat"): CampaignState =>
      replay({ ...won.state, encounter: downed }, [{ kind: "encounterEnded", outcome }]);
    expect(ended("victory").heroStatus["c-borin"]?.hp).toBe(1);
    expect(ended("victory").heroStatus["c-mira"]?.hp).toBe(9);
    expect(ended("defeat").heroStatus["c-borin"]?.hp).toBe(0);
  });
});
