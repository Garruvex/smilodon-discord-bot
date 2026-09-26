import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, kinds, newCampaign, organizer, reject, run, system } from "./campaign-fixtures.js";

// Round 1 resolved without checks: waiting for narration.
function resolvedRound(): CampaignState {
  let state = run(newCampaign(), system, { kind: "openRound" }).state;
  state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I open the door." }).state;
  state = run(state, jamie, { kind: "pass", characterId: "c-borin" }).state;
  return run(state, system, {
    kind: "applyRoundPlan",
    proposal: { roundNumber: 1, actions: [{ characterId: "c-mira", resolution: { kind: "automatic", reason: "Unlocked." } }] },
  }).state;
}

function planningRound(): CampaignState {
  let state = run(newCampaign(), system, { kind: "openRound" }).state;
  state = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I open the door." }).state;
  return run(state, jamie, { kind: "pass", characterId: "c-borin" }).state;
}

describe("narration", () => {
  it("records narration once and opens the next round", () => {
    const step = run(resolvedRound(), system, { kind: "recordNarration", roundNumber: 1, text: " The door creaks open. " });
    expect(kinds(step.events)).toEqual(["narrationRecorded", "roundOpened"]);
    expect(step.events[0]).toEqual({ kind: "narrationRecorded", roundNumber: 1, text: "The door creaks open." });
    expect(step.requests[0]).toEqual({ kind: "deliver", delivery: { kind: "narration", roundNumber: 1 } });
    expect(step.state.round?.number).toBe(2);
    expect(reject(step.state, system, { kind: "recordNarration", roundNumber: 1, text: "Again." })).toEqual({ code: "staleNarration" });
  });

  it("refuses narration for a round that is not resolved yet, and from players", () => {
    expect(reject(planningRound(), system, { kind: "recordNarration", roundNumber: 1, text: "Too early." })).toEqual({
      code: "staleNarration",
    });
    expect(reject(resolvedRound(), alex, { kind: "recordNarration", roundNumber: 1, text: "Mine." })).toEqual({ code: "systemOnly" });
    expect(reject(resolvedRound(), system, { kind: "recordNarration", roundNumber: 1, text: "  " })).toEqual({ code: "emptyNarration" });
  });

  it("keeps narration that arrives while the table is waiting, without opening a round", () => {
    let state = run(resolvedRound(), alex, { kind: "markAway", userId: "u-alex" }).state;
    state = run(state, jamie, { kind: "markAway", userId: "u-jamie" }).state;
    const step = run(state, system, { kind: "recordNarration", roundNumber: 1, text: "Silence falls." });
    expect(kinds(step.events)).toEqual(["narrationRecorded"]);
    expect(step.state.round).toBeNull();
  });
});

describe("planner failure and retry", () => {
  it("holds the round and tells the organizer", () => {
    const step = run(planningRound(), system, { kind: "reportPlannerFailure", roundNumber: 1, problems: ["bad DC"] });
    expect(step.events).toEqual([{ kind: "plannerFailed", roundNumber: 1, problems: ["bad DC"] }]);
    expect(step.requests).toEqual([
      { kind: "deliver", delivery: { kind: "dmHolding", roundNumber: 1 } },
      { kind: "deliver", delivery: { kind: "organizerNotice", notice: "plannerFailed", roundNumber: 1 } },
    ]);
    expect(step.state.round?.status).toBe("planning");
  });

  it("lets only the organizer ask the Planner to try again", () => {
    expect(reject(planningRound(), alex, { kind: "retryPlan" })).toEqual({ code: "notOrganizer" });
    expect(run(planningRound(), organizer, { kind: "retryPlan" }).requests).toEqual([{ kind: "plan", roundNumber: 1 }]);
    expect(reject(resolvedRound(), organizer, { kind: "retryPlan" })).toEqual({ code: "notPlanning" });
  });
});

describe("ledger facts", () => {
  it("adds facts under an entity and locks its first name", () => {
    let state = run(newCampaign(), system, {
      kind: "recordLedgerFact",
      entityId: "npc:garrick",
      canonicalName: "Garrick",
      fact: "Suspicious of the party.",
      visibility: "public",
    }).state;
    state = run(state, system, {
      kind: "recordLedgerFact",
      entityId: "npc:garrick",
      canonicalName: "Garrick",
      fact: "Works for the smugglers.",
      visibility: "secret",
    }).state;
    expect(state.ledger["npc:garrick"]).toEqual({
      entityId: "npc:garrick",
      canonicalName: "Garrick",
      facts: [
        { text: "Suspicious of the party.", visibility: "public" },
        { text: "Works for the smugglers.", visibility: "secret" },
      ],
    });
    expect(
      reject(state, system, { kind: "recordLedgerFact", entityId: "npc:garrick", canonicalName: "Garic", fact: "x", visibility: "public" }),
    ).toEqual({ code: "canonicalNameLocked", canonicalName: "Garrick" });
    expect(
      reject(state, system, { kind: "recordLedgerFact", entityId: "Garrick!", canonicalName: "G", fact: "x", visibility: "public" }),
    ).toEqual({ code: "invalidLedgerFact", problem: "entityId" });
  });
});
