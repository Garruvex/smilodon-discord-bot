import { describe, expect, it } from "vitest";

import type { EncounterSpec, PlannedEffect, RoundPlanProposal } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, kinds, newCampaign, organizer, partyOfThree, reject, run, sam, system } from "./campaign-fixtures.js";
import { skirmish } from "./combat-fixtures.js";

const chapel = "scene:ruined-chapel" as const;
const ambush: EncounterSpec = { ...skirmish, id: "encounter:chapel-ambush" };

const toChapel: PlannedEffect = { effect: { kind: "transitionScene", sceneId: chapel }, when: { kind: "always" } };
const chapelFight: PlannedEffect = { effect: { kind: "startEncounter", encounter: ambush }, when: { kind: "always" }, arrivalOf: chapel };

function plan(state: CampaignState, effects: readonly PlannedEffect[]): RoundPlanProposal {
  return {
    roundNumber: state.round?.number ?? 1,
    actions: Object.entries(state.round?.submissions ?? {}).flatMap(([characterId, submission]) =>
      submission.kind === "action" ? [{ characterId, resolution: { kind: "automatic" as const, reason: "Nothing stands in the way." } }] : [],
    ),
    effects,
  };
}

// Every hero in the round acts, so it closes.
function playRound(state: CampaignState): CampaignState {
  return (state.round?.participants ?? []).reduce((next, characterId) => {
    const owner = next.characters[characterId]?.ownerUserId ?? "";
    return run(next, { kind: "user", userId: owner }, { kind: "submitAction", characterId, text: "I look around." }).state;
  }, state);
}

// Round 1 ends with the Planner proposing a move and the Narrator telling it; round 2 is open.
function moveProposed(effects: readonly PlannedEffect[] = [toChapel], base: CampaignState = newCampaign()): CampaignState {
  let next = run(base, system, { kind: "openRound" }).state;
  next = playRound(next);
  next = run(next, system, { kind: "applyRoundPlan", proposal: plan(next, effects) }).state;
  return run(next, system, { kind: "recordNarration", roundNumber: 1, text: "The party heads for the chapel." }).state;
}

describe("a move the Planner proposes", () => {
  it("waits for the table instead of happening at once", () => {
    const state = moveProposed();
    expect(state.sceneId).not.toBe(chapel);
    expect(state.pendingMove).toMatchObject({ sceneId: chapel, proposedRound: 1, objectors: [] });
    expect(state.round?.number).toBe(2);
  });

  it("happens at once when the story forces it", () => {
    const state = moveProposed([{ ...toChapel, forced: true }]);
    expect(state.sceneId).toBe(chapel);
    expect(state.pendingMove).toBeUndefined();
  });

  it("holds a fight that waits at the destination until the party gets there", () => {
    const state = moveProposed([toChapel, chapelFight]);
    expect(state.pendingEncounter).toBeNull();
    expect(state.pendingMove?.effects.map((effect) => effect.kind)).toEqual(["transitionScene", "startEncounter"]);
  });

  it("goes when nobody objects, as the next round closes", () => {
    const closed = playRound(moveProposed());
    expect(closed.sceneId).toBe(chapel);
    expect(closed.pendingMove).toBeUndefined();
  });

  it("is not settled by the round that proposed it", () => {
    const state = playRound(run(newCampaign(), system, { kind: "openRound" }).state);
    const applied = run(state, system, { kind: "applyRoundPlan", proposal: plan(state, [toChapel]) });
    expect(kinds(applied.events)).toContain("sceneMoveProposed");
    expect(kinds(applied.events)).not.toContain("sceneMoveAgreed");
  });

  it("brings the fight along when the party goes", () => {
    const closed = playRound(moveProposed([toChapel, chapelFight]));
    expect(closed.sceneId).toBe(chapel);
    expect(closed.pendingEncounter?.id).toBe("encounter:chapel-ambush");
  });
});

describe("a fight proposed with a move", () => {
  const fightHere: PlannedEffect = { effect: { kind: "startEncounter", encounter: ambush }, when: { kind: "always" } };

  it("calls the move off, since the party is not going anywhere", () => {
    const state = run(newCampaign(), system, { kind: "openRound" }).state;
    const played = playRound(state);
    const applied = run(played, system, { kind: "applyRoundPlan", proposal: plan(played, [toChapel, fightHere]) });
    expect(kinds(applied.events)).toContain("encounterQueued");
    expect(kinds(applied.events)).not.toContain("sceneMoveProposed");
    expect(applied.state.pendingMove).toBeUndefined();
  });
});

describe("how the party got there, as recorded", () => {
  const arrivedBy = (state: CampaignState): string | undefined => state.visits?.at(-1)?.arrivedBy;

  it("says the table agreed, the organizer sent the party, or the story did", () => {
    expect(arrivedBy(playRound(moveProposed()))).toBe("agreed");
    expect(arrivedBy(run(moveProposed(), organizer, { kind: "settleMove", outcome: "go" }).state)).toBe("organizer");
    expect(arrivedBy(moveProposed([{ ...toChapel, forced: true }]))).toBe("story");
  });

  it("records nothing when the party stays", () => {
    expect(run(moveProposed(), organizer, { kind: "settleMove", outcome: "stay" }).state.visits).toBeUndefined();
  });
});

describe("objecting to a move", () => {
  it("stops it when more than half of the present players press Stay", () => {
    let state = moveProposed([toChapel], partyOfThree());
    state = run(state, alex, { kind: "objectToMove" }).state;
    state = run(state, jamie, { kind: "objectToMove" }).state;
    expect(state.pendingMove?.objectors).toEqual(["u-alex", "u-jamie"]);
    const closed = run(state, system, { kind: "roundTimerExpired", roundNumber: 2 });
    expect(kinds(closed.events)).toContain("sceneMoveDeclined");
    expect(closed.state.sceneId).not.toBe(chapel);
    expect(closed.state.pendingMove).toBeUndefined();
  });

  it("lets one holdout be outvoted in a party of three", () => {
    const state = run(moveProposed([toChapel], partyOfThree()), alex, { kind: "objectToMove" }).state;
    const closed = run(state, system, { kind: "roundTimerExpired", roundNumber: 2 });
    expect(kinds(closed.events)).toContain("sceneMoveAgreed");
    expect(closed.state.sceneId).toBe(chapel);
  });

  it("stays on a tie", () => {
    const state = run(moveProposed(), alex, { kind: "objectToMove" }).state;
    const closed = run(state, system, { kind: "roundTimerExpired", roundNumber: 2 });
    expect(kinds(closed.events)).toContain("sceneMoveDeclined");
  });

  it("counts a player once, and lets them take it back", () => {
    let state = run(moveProposed(), alex, { kind: "objectToMove" }).state;
    state = run(state, alex, { kind: "objectToMove" }).state;
    expect(state.pendingMove?.objectors).toEqual(["u-alex"]);
    state = run(state, alex, { kind: "withdrawObjection" }).state;
    expect(state.pendingMove?.objectors).toEqual([]);
  });

  it("does not count a player who has gone away", () => {
    let state = run(moveProposed([toChapel], partyOfThree()), alex, { kind: "objectToMove" }).state;
    state = run(state, sam, { kind: "markAway", userId: "u-sam" }).state;
    // Two of the three are present and one of them objects: half, so the move stays.
    expect(kinds(run(state, system, { kind: "roundTimerExpired", roundNumber: 2 }).events)).toContain("sceneMoveDeclined");
    const awayObjector = run(state, alex, { kind: "markAway", userId: "u-alex" }).state;
    expect(kinds(run(awayObjector, system, { kind: "roundTimerExpired", roundNumber: 2 }).events)).toContain("sceneMoveAgreed");
  });

  it("is refused when nothing is pending, for an outsider, or for someone away", () => {
    expect(reject(newCampaign(), alex, { kind: "objectToMove" })).toEqual({ code: "noPendingMove" });
    const state = moveProposed();
    expect(reject(state, sam, { kind: "objectToMove" })).toEqual({ code: "notMember" });
    const away = run(state, jamie, { kind: "markAway", userId: "u-jamie" }).state;
    expect(reject(away, jamie, { kind: "objectToMove" })).toEqual({ code: "memberAway" });
  });
});

describe("a player suggesting a move", () => {
  const suggest = { kind: "proposeMove", sceneId: chapel, effects: [{ kind: "transitionScene", sceneId: chapel }] } as const;
  const open = (): CampaignState => run(newCampaign(), system, { kind: "openRound" }).state;

  it("waits for the table, and settles as the round in progress closes", () => {
    const state = run(open(), alex, suggest).state;
    expect(state.pendingMove).toMatchObject({ sceneId: chapel, proposedRound: 0, objectors: [] });
    expect(state.sceneId).not.toBe(chapel);
    expect(playRound(state).sceneId).toBe(chapel);
  });

  it("can be objected to like any other", () => {
    let state = run(open(), alex, suggest).state;
    state = run(state, jamie, { kind: "objectToMove" }).state;
    const closed = run(state, system, { kind: "roundTimerExpired", roundNumber: 1 });
    expect(kinds(closed.events)).toContain("sceneMoveDeclined");
    expect(closed.state.sceneId).not.toBe(chapel);
  });

  it("records who suggested it", () => {
    expect(run(open(), alex, suggest).events.find((event) => event.kind === "sceneMoveProposed")).toMatchObject({ by: "u-alex" });
  });

  it("keeps the objections when the same move is suggested again, and replaces a different one", () => {
    let state = run(open(), alex, suggest).state;
    state = run(state, jamie, { kind: "objectToMove" }).state;
    state = run(state, alex, suggest).state;
    expect(state.pendingMove?.objectors).toEqual(["u-jamie"]);
    const elsewhere = "scene:old-watchtower" as const;
    state = run(state, alex, { kind: "proposeMove", sceneId: elsewhere, effects: [{ kind: "transitionScene", sceneId: elsewhere }] }).state;
    expect(state.pendingMove).toMatchObject({ sceneId: elsewhere, objectors: [] });
  });

  it("is refused for the scene the party is in, for effects that do not start with the move, and for an outsider or someone away", () => {
    const here = { ...open(), sceneId: chapel };
    expect(reject(here, alex, suggest)).toEqual({ code: "invalidMove" });
    expect(reject(open(), alex, { kind: "proposeMove", sceneId: chapel, effects: [] })).toEqual({ code: "invalidMove" });
    expect(reject(open(), sam, suggest)).toEqual({ code: "notMember" });
    const away = run(open(), jamie, { kind: "markAway", userId: "u-jamie" }).state;
    expect(reject(away, jamie, suggest)).toEqual({ code: "memberAway" });
  });
});

describe("the organizer settling a move", () => {
  it("can send the party now, or keep it where it is", () => {
    const go = run(moveProposed(), organizer, { kind: "settleMove", outcome: "go" });
    expect(go.state.sceneId).toBe(chapel);
    expect(go.events.find((event) => event.kind === "sceneMoveAgreed")).toMatchObject({ by: "organizer" });
    const stay = run(moveProposed(), organizer, { kind: "settleMove", outcome: "stay" });
    expect(stay.state.sceneId).not.toBe(chapel);
    expect(stay.state.pendingMove).toBeUndefined();
  });

  it("is for the organizer only, and needs a move to settle", () => {
    expect(reject(moveProposed(), alex, { kind: "settleMove", outcome: "go" })).toEqual({ code: "notOrganizer" });
    expect(reject(newCampaign(), organizer, { kind: "settleMove", outcome: "go" })).toEqual({ code: "noPendingMove" });
  });
});
