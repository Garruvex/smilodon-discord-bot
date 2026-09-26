import { describe, expect, it } from "vitest";

import type { RoundPlanProposal } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import {
  alex,
  d20Roll,
  jamie,
  kinds,
  newCampaign,
  organizer,
  reject,
  ruleset,
  run,
  system,
} from "./campaign-fixtures.js";

const miraSneaks: RoundPlanProposal = {
  roundNumber: 1,
  actions: [
    {
      characterId: "c-mira",
      resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "medium", rollModeReasons: ["help"] },
    },
  ],
};

// Round 1 open, Mira acted, Borin passed: the round is waiting for the Planner.
function closedRound(): CampaignState {
  let state = run(newCampaign(), system, { kind: "openRound" }).state;
  state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I slip past the guard." }).state;
  return run(state, jamie, { kind: "pass", characterId: "c-borin" }).state;
}

// Round 1 planned: Mira's Stealth check is pending.
function plannedRound(): CampaignState {
  return run(closedRound(), system, { kind: "applyRoundPlan", proposal: miraSneaks }, { now: 1_000 }).state;
}

describe("exploration rounds", () => {
  it("opens a round for present heroes with a window timer", () => {
    const step = run(newCampaign(), system, { kind: "openRound" }, { now: 10_000 });
    expect(step.events).toEqual([
      { kind: "roundOpened", roundNumber: 1, participants: ["c-mira", "c-borin"], closesAt: 310_000 },
    ]);
    expect(step.requests).toEqual([
      { kind: "startTimer", timer: { kind: "roundWindow", timerId: "round:1", dueAt: 310_000, roundNumber: 1 } },
    ]);
  });

  it("keeps the player's wording, counts revisions, and closes once everyone has responded", () => {
    let state = run(newCampaign(), system, { kind: "openRound" }).state;
    state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "  I listen at the door. " }).state;
    const revised = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I pick the lock." });
    expect(revised.events).toEqual([
      { kind: "actionSubmitted", roundNumber: 1, characterId: "c-mira", text: "I pick the lock.", revision: 2 },
    ]);
    expect(revised.requests).toEqual([]);

    const last = run(revised.state, jamie, { kind: "pass", characterId: "c-borin" });
    expect(kinds(last.events)).toEqual(["passSubmitted", "roundClosed"]);
    expect(last.events[1]).toEqual({ kind: "roundClosed", roundNumber: 1, reason: "allResponded", missed: [] });
    expect(last.requests).toEqual([
      { kind: "cancelTimer", timerId: "round:1" },
      { kind: "plan", roundNumber: 1 },
    ]);
    expect(last.state.round?.status).toBe("planning");
  });

  it("refuses actions for someone else's hero, empty actions, and actions outside the window", () => {
    const open = run(newCampaign(), system, { kind: "openRound" }).state;
    expect(reject(open, jamie, { kind: "submitAction", characterId: "c-mira", text: "Mira jumps." })).toEqual({ code: "notYourCharacter" });
    expect(reject(open, alex, { kind: "submitAction", characterId: "c-mira", text: "   " })).toEqual({ code: "emptyAction" });
    expect(reject(open, alex, { kind: "submitAction", characterId: "c-mira", text: "x".repeat(501) })).toEqual({
      code: "actionTooLong",
      maxLength: 500,
    });
    expect(reject(closedRound(), alex, { kind: "submitAction", characterId: "c-mira", text: "Wait!" })).toEqual({
      code: "roundNotCollecting",
    });
    expect(reject(newCampaign(), alex, { kind: "pass", characterId: "c-mira" })).toEqual({ code: "noOpenRound" });
  });

  it("lets only the organizer close the window early, without counting misses", () => {
    const open = run(newCampaign(), system, { kind: "openRound" }).state;
    expect(reject(open, alex, { kind: "closeRound" })).toEqual({ code: "notOrganizer" });

    const acted = run(open, alex, { kind: "submitAction", characterId: "c-mira", text: "I search the desk." }).state;
    const closed = run(acted, organizer, { kind: "closeRound" });
    expect(closed.events).toEqual([{ kind: "roundClosed", roundNumber: 1, reason: "organizer", missed: ["c-borin"] }]);
    expect(closed.state.members["u-jamie"]?.consecutiveMisses).toBe(0);
    expect(closed.state.round?.submissions["c-borin"]).toEqual({ kind: "missed" });
  });

  it("ends an all-pass round quietly: no Planner call and no automatic next round", () => {
    let state = run(newCampaign(), system, { kind: "openRound" }).state;
    state = run(state, alex, { kind: "pass", characterId: "c-mira" }).state;
    const last = run(state, jamie, { kind: "pass", characterId: "c-borin" });
    expect(kinds(last.events)).toEqual(["passSubmitted", "roundClosed", "roundResolved"]);
    expect(last.events[2]).toEqual({ kind: "roundResolved", roundNumber: 1, quiet: true });
    expect(last.requests).toEqual([
      { kind: "cancelTimer", timerId: "round:1" },
      { kind: "deliver", delivery: { kind: "quietRound", roundNumber: 1 } },
    ]);
    expect(last.state.round).toBeNull();

    // A present player starts the next round explicitly.
    expect(run(last.state, alex, { kind: "openRound" }).events[0]).toMatchObject({ kind: "roundOpened", roundNumber: 2 });
  });
});

describe("timers and away mode", () => {
  it("records misses on timeout and marks a player away after two timed-out rounds", () => {
    let state = run(newCampaign(), system, { kind: "openRound" }).state;
    state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I keep watch." }).state;
    const first = run(state, system, { kind: "roundTimerExpired", roundNumber: 1 });
    expect(first.events).toEqual([{ kind: "roundClosed", roundNumber: 1, reason: "timer", missed: ["c-borin"] }]);
    expect(first.state.members["u-jamie"]?.consecutiveMisses).toBe(1);

    // Skip to the next round (planning and narration are not under test here).
    state = { ...first.state, round: null };
    state = run(state, system, { kind: "openRound" }).state;
    state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I keep watch." }).state;
    const second = run(state, system, { kind: "roundTimerExpired", roundNumber: 2 });
    expect(kinds(second.events)).toEqual(["roundClosed", "memberMarkedAway"]);
    expect(second.events[1]).toEqual({ kind: "memberMarkedAway", userId: "u-jamie", reason: "missedTimers" });

    // The away player is left out of the next round.
    const third = run({ ...second.state, round: null }, system, { kind: "openRound" });
    expect(third.events[0]).toMatchObject({ participants: ["c-mira"] });
  });

  it("resets the miss streak when a player responds, even with a pass", () => {
    let state = run(newCampaign(), system, { kind: "openRound" }).state;
    state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I wait." }).state;
    state = run(state, system, { kind: "roundTimerExpired", roundNumber: 1 }).state;
    state = run({ ...state, round: null }, system, { kind: "openRound" }).state;
    state = run(state, jamie, { kind: "pass", characterId: "c-borin" }).state;
    expect(state.members["u-jamie"]?.consecutiveMisses).toBe(0);
  });

  it("ignores a window timer that fires after the round already closed", () => {
    const step = run(closedRound(), system, { kind: "roundTimerExpired", roundNumber: 1 });
    expect(step.events).toEqual([]);
    expect(step.requests).toEqual([]);
    expect(reject(closedRound(), alex, { kind: "roundTimerExpired", roundNumber: 1 })).toEqual({ code: "systemOnly" });
  });

  it("excuses an away player's open slot instead of counting a miss, and closes the round if that was the last one", () => {
    let state = run(newCampaign(), system, { kind: "openRound" }).state;
    state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I read the map." }).state;
    const away = run(state, jamie, { kind: "markAway", userId: "u-jamie" });
    expect(kinds(away.events)).toEqual(["memberMarkedAway", "slotExcused", "roundClosed"]);
    expect(away.events[0]).toEqual({ kind: "memberMarkedAway", userId: "u-jamie", reason: "self" });
    expect(away.state.members["u-jamie"]?.consecutiveMisses).toBe(0);
    expect(reject(state, alex, { kind: "markAway", userId: "u-jamie" })).toEqual({ code: "notOrganizer" });
  });

  it("waits for players when nobody is present, holding work until someone returns and continues", () => {
    const planned = closedRound();
    let state = run(planned, alex, { kind: "markAway", userId: "u-alex" }).state;
    const lastOut = run(state, organizer, { kind: "markAway", userId: "u-jamie" });
    expect(kinds(lastOut.events)).toEqual(["memberMarkedAway", "waitingForPlayers"]);
    expect(lastOut.events[0]).toMatchObject({ reason: "organizer" });
    state = lastOut.state;

    // Nothing proceeds while waiting.
    expect(reject(state, system, { kind: "applyRoundPlan", proposal: miraSneaks })).toEqual({ code: "campaignWaiting" });
    expect(reject(state, alex, { kind: "continue" })).toEqual({ code: "memberAway" });

    state = run(state, alex, { kind: "markReturned", userId: "u-alex" }).state;
    expect(state.status).toBe("waitingForPlayers");
    const resumed = run(state, alex, { kind: "continue" });
    expect(kinds(resumed.events)).toEqual(["resumed"]);
    expect(resumed.requests).toEqual([{ kind: "plan", roundNumber: 1 }]);
    expect(resumed.state.status).toBe("active");
  });

  it("enters waiting instead of opening a round when the system finds nobody present", () => {
    let state = run(newCampaign(), alex, { kind: "markAway", userId: "u-alex" }).state;
    state = run(state, jamie, { kind: "markAway", userId: "u-jamie" }).state;
    expect(state.status).toBe("waitingForPlayers");
    expect(reject(state, system, { kind: "openRound" })).toEqual({ code: "campaignWaiting" });
  });
});

describe("round plans and checks", () => {
  it("fixes the DC, modifier, and advantage before the roll and starts a roll timer", () => {
    const step = run(closedRound(), system, { kind: "applyRoundPlan", proposal: miraSneaks }, { now: 1_000 });
    const check = step.state.checks["r1:c-mira"];
    expect(check).toMatchObject({
      dc: 15,
      spec: { mode: "advantage", modifier: 7, bonusDice: [] },
      status: "pending",
      rollId: "r1:c-mira:roll",
      deadline: 121_000,
    });
    expect(step.state.round?.resolutions).toEqual({ "c-mira": { kind: "check", checkId: "r1:c-mira" } });
    expect(step.requests).toEqual([
      { kind: "startTimer", timer: { kind: "roll", timerId: "roll:r1:c-mira", dueAt: 121_000, checkId: "r1:c-mira" } },
    ]);
  });

  it("rejects the whole plan and lists every problem", () => {
    const bad = {
      roundNumber: 1,
      actions: [
        { characterId: "c-borin", resolution: { kind: "automatic", reason: "He waits." } },
        {
          characterId: "c-mira",
          resolution: { kind: "check", test: { kind: "skill", skill: "sneaking" }, dcTier: "tricky", rollModeReasons: ["luck"] },
        },
      ],
    } as unknown as RoundPlanProposal;
    expect(reject(closedRound(), system, { kind: "applyRoundPlan", proposal: bad })).toEqual({
      code: "invalidPlan",
      problems: [
        "c-borin: has no submitted action this round.",
        'c-mira: unknown skill "sneaking".',
        'c-mira: DC tier "tricky" is not on the ladder.',
        'c-mira: unknown advantage reason "luck".',
      ],
    });
    expect(reject(closedRound(), system, { kind: "applyRoundPlan", proposal: { roundNumber: 1, actions: [] } })).toEqual({
      code: "invalidPlan",
      problems: ["c-mira: action was not planned."],
    });
    expect(reject(closedRound(), system, { kind: "applyRoundPlan", proposal: { ...miraSneaks, roundNumber: 2 } })).toEqual({
      code: "stalePlan",
    });
  });

  it("resolves a round with no checks straight away and asks for narration", () => {
    const proposal: RoundPlanProposal = {
      roundNumber: 1,
      actions: [{ characterId: "c-mira", resolution: { kind: "automatic", reason: "The door is unlocked." } }],
    };
    const step = run(closedRound(), system, { kind: "applyRoundPlan", proposal });
    expect(kinds(step.events)).toEqual(["roundPlanApplied", "roundResolved"]);
    expect(step.requests).toEqual([{ kind: "narrate", roundNumber: 1 }]);
  });

  it("rolls once per click, then resolves the saved roll with its moments and finishes the round", () => {
    const planned = plannedRound();
    expect(reject(planned, jamie, { kind: "requestRoll", checkId: "r1:c-mira" })).toEqual({ code: "notYourCharacter" });

    const clicked = run(planned, alex, { kind: "requestRoll", checkId: "r1:c-mira" });
    expect(clicked.events).toEqual([{ kind: "checkRollStarted", checkId: "r1:c-mira", rollId: "r1:c-mira:roll", timedOut: false }]);
    expect(clicked.requests).toEqual([
      { kind: "cancelTimer", timerId: "roll:r1:c-mira" },
      { kind: "roll", rollId: "r1:c-mira:roll", spec: { kind: "d20Test", spec: { mode: "advantage", modifier: 7, bonusDice: [] } } },
      { kind: "deliver", delivery: { kind: "rollStarted", checkId: "r1:c-mira" } },
    ]);
    expect(reject(clicked.state, alex, { kind: "requestRoll", checkId: "r1:c-mira" })).toEqual({ code: "checkNotPending" });

    // Advantage kept the 8; the 3 alone would have failed (3 + 7 = 10 < 15).
    const roll = d20Roll("advantage", [3, 8], 7);
    const recorded = run(clicked.state, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll } });
    expect(recorded.events).toEqual([
      {
        kind: "checkResolved",
        checkId: "r1:c-mira",
        result: { roll, success: true, moments: { headline: { kind: "exactlyEnough" }, tags: [{ kind: "advantageSaved" }] } },
      },
      { kind: "roundResolved", roundNumber: 1, quiet: false },
    ]);
    expect(recorded.requests).toEqual([
      { kind: "deliver", delivery: { kind: "rollResult", checkId: "r1:c-mira" } },
      { kind: "narrate", roundNumber: 1 },
    ]);

    // A redelivered roll job changes nothing.
    const resolvedCheck = run(clicked.state, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll } }).state;
    expect(run(resolvedCheck, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll } }).events).toEqual([]);
  });

  it("refuses a recorded roll that does not match the saved check", () => {
    const clicked = run(plannedRound(), alex, { kind: "requestRoll", checkId: "r1:c-mira" }).state;
    expect(reject(clicked, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll: d20Roll("normal", [12], 7) } })).toEqual({
      code: "rollMismatch",
    });
    expect(reject(clicked, alex, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll: d20Roll("advantage", [3, 8], 7) } })).toEqual({
      code: "systemOnly",
    });
  });

  it("auto-rolls the saved check once when the roll timer expires", () => {
    const expired = run(plannedRound(), system, { kind: "rollTimerExpired", checkId: "r1:c-mira" });
    expect(expired.events).toEqual([{ kind: "checkRollStarted", checkId: "r1:c-mira", rollId: "r1:c-mira:roll", timedOut: true }]);
    expect(kinds(expired.requests)).toEqual(["roll", "deliver"]);
    // The player's late click and a second expiry both find nothing to do.
    expect(reject(expired.state, alex, { kind: "requestRoll", checkId: "r1:c-mira" })).toEqual({ code: "checkNotPending" });
    expect(run(expired.state, system, { kind: "rollTimerExpired", checkId: "r1:c-mira" }).events).toEqual([]);
  });

  it("applies the natural-roll house rule to check outcomes", () => {
    const clicked = run(plannedRound(), alex, { kind: "requestRoll", checkId: "r1:c-mira" }).state;
    const roll = d20Roll("advantage", [1, 1], 7);
    const rulesAsWritten = run(clicked, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll } });
    expect(rulesAsWritten.events[0]).toMatchObject({ result: { success: false, moments: { headline: { kind: "natural1" } } } });

    const high = d20Roll("advantage", [20, 2], 7);
    const houseRule = run(clicked, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll: high } }, {
      rules: ruleset({ "natural-rolls-on-checks": "automatic" }),
    });
    expect(houseRule.events[0]).toMatchObject({ result: { success: true, moments: { headline: { kind: "natural20" } } } });
  });
});
