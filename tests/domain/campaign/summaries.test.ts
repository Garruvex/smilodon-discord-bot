import { describe, expect, it } from "vitest";

import { latestSummaryRound } from "../../../src/domain/campaign/engine/dm.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, kinds, newCampaign, reject, run, system } from "./campaign-fixtures.js";

// Plays quiet rounds until `count` are narrated.
function narrated(count: number, state: CampaignState = newCampaign()): { state: CampaignState; requests: readonly { kind: string }[][] } {
  let current = state;
  const perRound: { kind: string }[][] = [];
  for (let round = 1; round <= count; round += 1) {
    if (current.round === null) current = run(current, system, { kind: "openRound" }).state;
    current = run(current, alex, { kind: "submitAction", characterId: "c-mira", text: "I look around." }).state;
    current = run(current, jamie, { kind: "submitAction", characterId: "c-borin", text: "I keep watch." }).state;
    const auto = { kind: "automatic", reason: "Simple." } as const;
    current = run(current, system, { kind: "applyRoundPlan", proposal: { roundNumber: round, actions: [{ characterId: "c-mira", resolution: auto }, { characterId: "c-borin", resolution: auto }], effects: [] } }).state;
    const step = run(current, system, { kind: "recordNarration", roundNumber: round, text: `Round ${round} passed.` });
    perRound.push([...step.requests]);
    current = step.state;
  }
  return { state: current, requests: perRound };
}

describe("the Chronicler's summaries", () => {
  it("keeps a summary of rounds already told, oldest first, per audience", () => {
    const { state } = narrated(2);
    const first = run(state, system, { kind: "recordSummary", throughRound: 1, visibility: "public", text: "The party met the innkeeper." });
    expect(kinds(first.events)).toEqual(["summaryRecorded"]);
    const second = run(first.state, system, { kind: "recordSummary", throughRound: 2, visibility: "public", text: "They set out for the tower." });
    const secret = run(second.state, system, { kind: "recordSummary", throughRound: 2, visibility: "private", text: "Garrick pays the raiders." });
    expect(secret.state.summaries).toEqual([
      { throughRound: 1, visibility: "public", text: "The party met the innkeeper." },
      { throughRound: 2, visibility: "public", text: "They set out for the tower." },
      { throughRound: 2, visibility: "private", text: "Garrick pays the raiders." },
    ]);
    expect(latestSummaryRound(secret.state.summaries, "public")).toBe(2);
    expect(latestSummaryRound(undefined, "private")).toBe(0);
  });

  it("refuses a late summary, one for rounds not yet told, and one that is not the Chronicler's", () => {
    const { state } = narrated(2);
    const done = run(state, system, { kind: "recordSummary", throughRound: 2, visibility: "public", text: "Two rounds." }).state;
    // A delayed Chronicler cannot overwrite what newer rounds already replaced.
    expect(reject(done, system, { kind: "recordSummary", throughRound: 1, visibility: "public", text: "Late." })).toEqual({ code: "staleSummary" });
    expect(reject(done, system, { kind: "recordSummary", throughRound: 2, visibility: "public", text: "Again." })).toEqual({ code: "staleSummary" });
    expect(reject(state, system, { kind: "recordSummary", throughRound: 3, visibility: "public", text: "Future." })).toEqual({ code: "staleSummary" });
    expect(reject(state, alex, { kind: "recordSummary", throughRound: 1, visibility: "public", text: "Mine." })).toEqual({ code: "systemOnly" });
  });

  it("refuses an empty or huge summary, and one that states hit points, slots or gold", () => {
    const { state } = narrated(1);
    const attempt = (text: string): unknown => reject(state, system, { kind: "recordSummary", throughRound: 1, visibility: "public", text });
    expect(attempt("   ")).toEqual({ code: "invalidSummary", problem: "text" });
    expect(attempt("x".repeat(1_501))).toEqual({ code: "invalidSummary", problem: "text" });
    for (const text of ["Mira is down to 4 HP.", "The party has 30 gold.", "Elspeth has 1 slot left.", "HP: 3", "米拉只剩 4 點生命", "隊伍有 30 金幣"]) {
      expect(attempt(text), text).toEqual({ code: "invalidSummary", problem: "numbers" });
    }
    // Ordinary numbers are fine.
    expect(run(state, system, { kind: "recordSummary", throughRound: 1, visibility: "public", text: "Three goblins fled at dusk." }).events).toHaveLength(1);
  });

  it("keeps same-scene rounds without requesting periodic summaries", () => {
    const { requests } = narrated(13);
    expect(requests.flat().filter((request) => request.kind === "chronicle")).toEqual([]);
  });

  it("requests private memory when the narrated round closes a scene", () => {
    const { state } = narrated(1);
    let current = run(state, alex, { kind: "submitAction", characterId: "c-mira", text: "I leave." }).state;
    current = run(current, jamie, { kind: "pass", characterId: "c-borin" }).state;
    current = run(current, system, { kind: "applyRoundPlan", proposal: { roundNumber: 2, actions: [{ characterId: "c-mira", resolution: { kind: "automatic", reason: "The way is clear." } }], effects: [] } }).state;
    const step = run({ ...current, sceneChangedRound: 2 }, system, { kind: "recordNarration", roundNumber: 2, text: "The party leaves the inn." });
    expect(step.requests.filter((request) => request.kind === "chronicle")).toEqual([{ kind: "chronicle", throughRound: 2, privateOnly: true }]);
  });
});
