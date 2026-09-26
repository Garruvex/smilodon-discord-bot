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

describe("clocks and clues", () => {
  const tick = (by: number, onFull: EncounterSpec | null = null): PlannedEffect => ({
    effect: { kind: "advanceClock", clockId: "clock:scouts", segments: 3, by, onFull },
    when: { kind: "always" },
  });
  const learn: PlannedEffect = { effect: { kind: "revealClue", clueId: "clue:map", text: "A map marks the chapel." }, when: { kind: "always" } };

  // Plays round 1 with the effects and resolves Mira's check with the given d20.
  function afterRound(state: CampaignState, effects: readonly PlannedEffect[], d20 = 3): CampaignState {
    const planned = run(closedRound(state), system, { kind: "applyRoundPlan", proposal: sneaking(effects) }).state;
    return rollStealth(planned, d20).state;
  }

  it("fills a clock over rounds, and starts its fight when it fills", () => {
    const first = afterRound(newCampaign(), [tick(2, ambush)]);
    expect(first.clocks["clock:scouts"]).toEqual({ segments: 3, filled: 2 });
    expect(first.pendingEncounter).toBeNull();

    // The next round carries on from the saved progress and caps at the size.
    let state = run(first, system, { kind: "recordNarration", roundNumber: 1, text: "Footsteps below." }).state;
    state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I sneak." }).state;
    state = run(state, jamie, { kind: "pass", characterId: "c-borin" }).state;
    state = run(state, system, { kind: "applyRoundPlan", proposal: { ...sneaking([tick(3, ambush)]), roundNumber: 2 } }).state;
    state = run(state, alex, { kind: "requestRoll", checkId: "r2:c-mira" }).state;
    const filled = run(state, system, { kind: "recordRoll", rollId: "r2:c-mira:roll", result: { kind: "d20Test", roll: d20Roll("normal", [15], 7) } });
    expect(kinds(filled.events)).toEqual(["checkResolved", "clockAdvanced", "encounterQueued", "roundResolved"]);
    expect(filled.state.clocks["clock:scouts"]).toEqual({ segments: 3, filled: 3 });
    expect(filled.state.pendingEncounter?.id).toBe("encounter:gate-ambush");
  });

  it("queues only one fight, ignores a full clock, and reveals each clue once", () => {
    const both = afterRound(newCampaign(), [ambushIfSpotted, tick(3, { ...ambush, id: "encounter:other" })]);
    expect(both.pendingEncounter?.id).toBe("encounter:gate-ambush");
    expect(both.clocks["clock:scouts"]?.filled).toBe(3);

    const learned = afterRound(newCampaign(), [learn]);
    expect(learned.clues).toEqual([{ id: "clue:map", text: "A map marks the chapel." }]);
    const twice = afterRound({ ...newCampaign(), clues: learned.clues, clocks: { "clock:scouts": { segments: 3, filled: 3 } } }, [learn, tick(1)]);
    expect(twice.clues).toHaveLength(1);
    expect(twice.clocks["clock:scouts"]?.filled).toBe(3);
  });

  it("refuses bad advances and repeated clocks in one round", () => {
    const blank: PlannedEffect = { effect: { kind: "revealClue", clueId: "clue:map", text: " " }, when: { kind: "always" } };
    const rejection = reject(closedRound(), system, { kind: "applyRoundPlan", proposal: sneaking([tick(0), tick(5), blank]) });
    expect(rejection).toEqual({
      code: "invalidPlan",
      problems: [
        "Advance each clock at most once per round.",
        "Clock clock:scouts may advance by 1 to 3 segments.",
        "Clock clock:scouts may advance by 1 to 3 segments.",
        "Clue clue:map needs text.",
      ],
    });
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
  it("brings heroes at 0 HP back with 1 HP after a victory or a defeat", () => {
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
    expect(ended("defeat").heroStatus["c-borin"]?.hp).toBe(1);
  });
});
