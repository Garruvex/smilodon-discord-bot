import { describe, expect, it } from "vitest";

import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, kinds, livePacing, newCampaign, organizer, reject, run, system } from "./campaign-fixtures.js";
import { startedFight } from "./combat-fixtures.js";

const open = (): CampaignState => run(newCampaign(livePacing), system, { kind: "openRound" }).state;

describe("speaking in character", () => {
  it("tells the table and the DM without using the action slot or changing the state", () => {
    const state = open();
    const step = run(state, alex, { kind: "speak", characterId: "c-mira", text: "  I have a bad feeling about this door.  " });
    expect(kinds(step.events)).toEqual(["heroSpoke"]);
    expect(step.events[0]).toEqual({ kind: "heroSpoke", characterId: "c-mira", roundNumber: 1, text: "I have a bad feeling about this door." });
    expect(step.requests).toEqual([{ kind: "deliver", delivery: { kind: "speech", characterId: "c-mira", text: "I have a bad feeling about this door." } }]);
    expect(step.state).toEqual(state);
    // The hero can still act, and speaking again is fine.
    const acted = run(step.state, alex, { kind: "submitAction", characterId: "c-mira", text: "I open it." });
    expect(acted.state.round?.submissions["c-mira"]).toMatchObject({ kind: "action" });
    expect(kinds(run(acted.state, alex, { kind: "speak", characterId: "c-mira", text: "Ready?" }).events)).toEqual(["heroSpoke"]);
  });

  it("speaks in a fight too, and does not cost a turn", () => {
    const fight = startedFight(newCampaign(livePacing));
    const step = run(fight.state, alex, { kind: "speak", characterId: "c-mira", text: "For the tower!" });
    expect(step.state.encounter).toEqual(fight.state.encounter);
    // A player may speak on someone else's turn.
    expect(kinds(run(fight.state, jamie, { kind: "speak", characterId: "c-borin", text: "Watch the stairs." }).events)).toEqual(["heroSpoke"]);
  });

  it("is only for a player's own hero, while play is running, with something to say", () => {
    const state = open();
    expect(reject(state, alex, { kind: "speak", characterId: "c-borin", text: "Hi." })).toEqual({ code: "notYourCharacter" });
    expect(reject(state, organizer, { kind: "speak", characterId: "c-mira", text: "Hi." })).toEqual({ code: "notYourCharacter" });
    expect(reject(state, system, { kind: "speak", characterId: "c-mira", text: "Hi." })).toEqual({ code: "notYourCharacter" });
    expect(reject(state, alex, { kind: "speak", characterId: "c-nobody", text: "Hi." })).toEqual({ code: "notYourCharacter" });
    expect(reject(state, alex, { kind: "speak", characterId: "c-mira", text: "   " })).toEqual({ code: "emptyAction" });
    expect(reject(state, alex, { kind: "speak", characterId: "c-mira", text: "x".repeat(301) })).toEqual({ code: "actionTooLong", maxLength: 300 });
    expect(kinds(run(state, alex, { kind: "speak", characterId: "c-mira", text: "x".repeat(300) }).events)).toEqual(["heroSpoke"]);
    const paused = run(state, organizer, { kind: "pauseCampaign", reason: "organizer" }).state;
    expect(reject(paused, alex, { kind: "speak", characterId: "c-mira", text: "Hi." })).toEqual({ code: "campaignWaiting" });
  });
});

describe("a safety pause", () => {
  it("lets any player at the table stop play for everyone, and only the organizer resumes", () => {
    const state = open();
    const paused = run(state, jamie, { kind: "pauseCampaign", reason: "safety" });
    expect(kinds(paused.events)).toEqual(["campaignPaused"]);
    expect(paused.events[0]).toEqual({ kind: "campaignPaused", reason: "safety" });
    expect(paused.requests).toContainEqual({ kind: "deliver", delivery: { kind: "campaignPaused", reason: "safety" } });
    expect(paused.state).toMatchObject({ status: "waitingForPlayers", pausedBy: "safety" });
    // Nobody can carry on, and the pause names nobody.
    expect(reject(paused.state, alex, { kind: "submitAction", characterId: "c-mira", text: "I go." })).toEqual({ code: "campaignWaiting" });
    expect(reject(paused.state, jamie, { kind: "continue" })).toEqual({ code: "notOrganizer" });
    expect(run(paused.state, organizer, { kind: "continue" }).state).toMatchObject({ status: "active", pausedBy: null });
  });

  it("stops a fight's turn timer and holds the turn", () => {
    const fight = startedFight(newCampaign(livePacing));
    const paused = run(fight.state, alex, { kind: "pauseCampaign", reason: "safety" });
    expect(paused.requests.some((request) => request.kind === "cancelTimer")).toBe(true);
    expect(reject(paused.state, alex, { kind: "combatDodge", combatantId: "c-mira" })).toEqual({ code: "campaignWaiting" });
  });

  it("is not for outsiders or the system, and is harmless twice", () => {
    const state = open();
    expect(reject(state, { kind: "user", userId: "u-stranger" }, { kind: "pauseCampaign", reason: "safety" })).toEqual({ code: "notMember" });
    expect(reject(state, system, { kind: "pauseCampaign", reason: "safety" })).toEqual({ code: "notMember" });
    const once = run(state, alex, { kind: "pauseCampaign", reason: "safety" }).state;
    const twice = run(once, jamie, { kind: "pauseCampaign", reason: "safety" });
    expect(twice.events).toEqual([]);
    expect(twice.state).toEqual(once);
  });
});
