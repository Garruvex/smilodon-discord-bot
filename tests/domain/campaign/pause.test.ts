import { describe, expect, it } from "vitest";

import { alex, jamie, kinds, livePacing, newCampaign, organizer, reject, run, system } from "./campaign-fixtures.js";
import { startedFight } from "./combat-fixtures.js";

const timed = { ...livePacing, roundSeconds: 300, rollSeconds: 120, turnSeconds: 180 };

describe("pausing the campaign", () => {
  it("cancels the round timer, holds play, and lets only the organizer resume with a fresh window", () => {
    const open = run(newCampaign(timed), system, { kind: "openRound" }, { now: 0 });
    expect(open.state.round?.closesAt).toBe(300_000);

    const paused = run(open.state, organizer, { kind: "pauseCampaign", reason: "organizer" }, { now: 100_000 });
    expect(kinds(paused.events)).toEqual(["campaignPaused"]);
    expect(paused.requests).toContainEqual({ kind: "cancelTimer", timerId: "round:1" });
    expect(paused.state).toMatchObject({ status: "waitingForPlayers", pausedBy: "organizer" });
    expect(reject(paused.state, alex, { kind: "submitAction", characterId: "c-mira", text: "I look around." })).toEqual({ code: "campaignWaiting" });

    expect(reject(paused.state, alex, { kind: "continue" })).toEqual({ code: "notOrganizer" });
    const resumed = run(paused.state, organizer, { kind: "continue" }, { now: 1_000_000 });
    expect(resumed.state).toMatchObject({ status: "active", pausedBy: null, round: { closesAt: 1_300_000 } });
    expect(resumed.requests).toContainEqual({
      kind: "startTimer",
      timer: { kind: "roundWindow", timerId: "round:1", dueAt: 1_300_000, roundNumber: 1 },
    });
    // Play carries on where it stopped.
    expect(run(resumed.state, alex, { kind: "submitAction", characterId: "c-mira", text: "I look around." }).state.round?.submissions["c-mira"]).toBeDefined();
  });

  it("is harmless twice, and only for the organizer", () => {
    const state = run(newCampaign(timed), system, { kind: "openRound" }).state;
    expect(reject(state, alex, { kind: "pauseCampaign", reason: "organizer" })).toEqual({ code: "notOrganizer" });
    expect(reject(state, organizer, { kind: "pauseCampaign", reason: "recovery" })).toEqual({ code: "systemOnly" });
    const once = run(state, organizer, { kind: "pauseCampaign", reason: "organizer" }).state;
    const twice = run(once, organizer, { kind: "pauseCampaign", reason: "organizer" });
    expect(twice.events).toEqual([]);
    expect(twice.state).toEqual(once);
  });

  it("holds a restart pause until the organizer resumes, and re-arms pending roll timers", () => {
    let state = run(newCampaign(timed), system, { kind: "openRound" }).state;
    state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I sneak past." }).state;
    state = run(state, jamie, { kind: "pass", characterId: "c-borin" }).state;
    state = run(state, system, {
      kind: "applyRoundPlan",
      proposal: {
        roundNumber: 1,
        actions: [{ characterId: "c-mira", resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "medium", rollModeReasons: [] } }],
      },
    }).state;
    const paused = run(state, system, { kind: "pauseCampaign", reason: "recovery" }, { now: 50 });
    expect(paused.requests).toContainEqual({ kind: "cancelTimer", timerId: "roll:r1:c-mira" });
    expect(paused.state.pausedBy).toBe("recovery");
    expect(reject(paused.state, alex, { kind: "continue" })).toEqual({ code: "notOrganizer" });
    const resumed = run(paused.state, organizer, { kind: "continue" }, { now: 500_000 });
    expect(resumed.state.checks["r1:c-mira"]?.deadline).toBe(620_000);
    expect(resumed.requests).toContainEqual({ kind: "startTimer", timer: { kind: "roll", timerId: "roll:r1:c-mira", dueAt: 620_000, checkId: "r1:c-mira" } });
  });

  it("stops a fight's turn timer and gives the player a fresh turn on resume", () => {
    const fight = startedFight(newCampaign(timed));
    const timerBefore = fight.encounter.turnEndsAt;
    expect(timerBefore).not.toBeNull();
    const paused = run(fight.state, organizer, { kind: "pauseCampaign", reason: "organizer" }, { now: 10_000 });
    expect(paused.requests).toContainEqual({ kind: "cancelTimer", timerId: `turn:enc-1:${fight.encounter.turnNumber}` });
    const resumed = run(paused.state, organizer, { kind: "continue" }, { now: 900_000 });
    expect(resumed.state.encounter?.turnEndsAt).toBe(1_080_000);
    expect(resumed.requests).toContainEqual({
      kind: "startTimer",
      timer: { kind: "combatTurn", timerId: `turn:enc-1:${fight.encounter.turnNumber}`, dueAt: 1_080_000, encounterId: "enc-1", turnNumber: fight.encounter.turnNumber },
    });
    // The same player can still act.
    expect(run(resumed.state, alex, { kind: "endTurn", combatantId: "c-mira" }).events.length).toBeGreaterThan(0);
  });
});
