import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, kinds, newCampaign, organizer, reject, run, system } from "./campaign-fixtures.js";

// A rest asked for during a round waits for it to end, then the party rests until the organizer finishes: no round opens meanwhile.

function openRound(): CampaignState {
  return run({ ...newCampaign(), sceneId: "scene:tavern" }, system, { kind: "openRound" }).state;
}

// Round 1 resolved without checks: waiting for the Narrator's text.
function resolvedRound(from: CampaignState = openRound()): CampaignState {
  let state = run(from, alex, { kind: "submitAction", characterId: "c-mira", text: "I open the door." }).state;
  state = run(state, jamie, { kind: "pass", characterId: "c-borin" }).state;
  return run(state, system, { kind: "applyRoundPlan", proposal: { roundNumber: 1, actions: [{ characterId: "c-mira", resolution: { kind: "automatic", reason: "Unlocked." } }] } }).state;
}

describe("asking for a rest during a round", () => {
  it("is the organizer's to ask, and is kept while the round is going", () => {
    expect(reject(openRound(), alex, { kind: "queueRest", rest: "short" })).toEqual({ code: "notOrganizer" });
    const asked = run(openRound(), organizer, { kind: "queueRest", rest: "long" });
    expect(kinds(asked.events)).toEqual(["restQueued"]);
    expect(asked.state.pendingRest).toMatchObject({ rest: "long" });
    expect(asked.state.resting).toBeUndefined();
  });

  it("can be taken back", () => {
    const asked = run(openRound(), organizer, { kind: "queueRest", rest: "short" });
    const undone = run(asked.state, organizer, { kind: "queueRest", rest: null });
    expect(undone.state.pendingRest).toBeUndefined();
  });

  it("is taken when the round ends, and the next round waits for the organizer", () => {
    const asked = run(resolvedRound(run(openRound(), organizer, { kind: "queueRest", rest: "short" }).state), system, { kind: "recordNarration", roundNumber: 1, text: "The door creaks open." });
    expect(kinds(asked.events)).toEqual(["narrationRecorded", "restTaken"]);
    expect(asked.state.resting).toBe("short");
    expect(asked.state.pendingRest).toBeUndefined();
    expect(asked.state.round).toBeNull();
    expect(asked.state.shortRestOpen).toBe(true);
  });

  it("is finished by the organizer's continue, which opens the next round", () => {
    const resting = run(resolvedRound(run(openRound(), organizer, { kind: "queueRest", rest: "short" }).state), system, { kind: "recordNarration", roundNumber: 1, text: "The door creaks open." }).state;
    expect(reject(resting, alex, { kind: "continue" })).toEqual({ code: "notOrganizer" });
    const done = run(resting, organizer, { kind: "continue" });
    expect(kinds(done.events)).toEqual(["restEnded", "roundOpened"]);
    expect(done.state.resting).toBeUndefined();
    expect(done.state.round?.number).toBe(2);
    expect(done.state.shortRestOpen).toBe(false);
  });
});

describe("asking for a rest when nothing is going", () => {
  it("takes it at once and holds the next round", () => {
    const idle = resolvedRound();
    const step = run(idle, organizer, { kind: "queueRest", rest: "long" });
    expect(kinds(step.events)).toContain("restTaken");
    expect(step.state.resting).toBe("long");
    const after = run(step.state, system, { kind: "recordNarration", roundNumber: 1, text: "Time passes." });
    expect(after.state.round).toBeNull();
  });
});
