import { describe, expect, it } from "vitest";

import type { PlannedEffect, RoundPlanProposal } from "../../../src/domain/campaign/commands/campaign-command.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, d20Roll, jamie, kinds, newCampaign, reject, run, system } from "./campaign-fixtures.js";

// The story graph's engine half: authored DCs, flags, one-time rewards, payments, and effects that hang on several heroes' checks.

const always = { kind: "always" } as const;
const anyMira = (success: boolean, atLeast?: number): PlannedEffect["when"] => ({ kind: "anyCheck", characterIds: ["c-mira"], success, ...(atLeast === undefined ? {} : { atLeast }) });

function plan(effects: readonly PlannedEffect[], dc?: number): RoundPlanProposal {
  return {
    roundNumber: 1,
    actions: [{ characterId: "c-mira", resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "medium", ...(dc === undefined ? {} : { dc }), rollModeReasons: [] } }],
    effects,
  };
}

function closedRound(state: CampaignState = newCampaign()): CampaignState {
  let next = run(state, system, { kind: "openRound" }).state;
  next = run(next, alex, { kind: "submitAction", characterId: "c-mira", text: "I search the barn." }).state;
  return run(next, jamie, { kind: "pass", characterId: "c-borin" }).state;
}

// Mira's Stealth is +7: the given d20 plus seven is her total.
function rolled(state: CampaignState, proposal: RoundPlanProposal, d20: number): ReturnType<typeof run> {
  const planned = run(closedRound(state), system, { kind: "applyRoundPlan", proposal }).state;
  const rolling = run(planned, alex, { kind: "requestRoll", checkId: "r1:c-mira" }).state;
  return run(rolling, system, { kind: "recordRoll", rollId: "r1:c-mira:roll", result: { kind: "d20Test", roll: d20Roll("normal", [d20], 7) } });
}

describe("an authored difficulty", () => {
  it("replaces the tier's DC, so a total of 11 beats DC 11 and misses DC 12", () => {
    const beats = rolled(newCampaign(), plan([{ effect: { kind: "setFlag", flag: "found", value: 1 }, when: anyMira(true) }], 11), 4);
    expect(beats.state.flags).toEqual({ found: 1 });
    expect(Object.values(beats.state.checks)[0]?.dc).toBe(11);
    const misses = rolled(newCampaign(), plan([{ effect: { kind: "setFlag", flag: "found", value: 1 }, when: anyMira(true) }], 12), 4);
    expect(misses.state.flags).toBeUndefined();
  });

  it("refuses a DC outside 1 to 30", () => {
    expect(reject(closedRound(), system, { kind: "applyRoundPlan", proposal: plan([], 31) })).toMatchObject({ code: "invalidPlan" });
  });
});

describe("rewards, flags and payments", () => {
  const reward = (id: string, gold: number): PlannedEffect["effect"] => ({ kind: "grantReward", rewardId: id, gold, items: [] });

  it("pays a reward into the purse once, and the same reward is never paid twice", () => {
    const first = rolled(newCampaign(), plan([{ effect: reward("interaction:bent:s:0", 80), when: anyMira(true) }], 10), 10);
    expect(first.state.gold).toBe(80);
    expect(kinds(first.events)).toContain("lootFound");
    const granted = { ...newCampaign(), gold: 80, flags: { "reward:interaction:bent:s:0": 1 } };
    const again = rolled(granted, plan([{ effect: reward("interaction:bent:s:0", 80), when: anyMira(true) }], 10), 10);
    expect(again.state.gold).toBe(80);
  });

  it("adds a higher tier's reward only when the total reaches it", () => {
    const effects: PlannedEffect[] = [
      { effect: reward("base", 10), when: anyMira(true) },
      { effect: reward("tier", 90), when: anyMira(true, 20) },
    ];
    expect(rolled(newCampaign(), plan(effects, 10), 5).state.gold).toBe(10);
    expect(rolled(newCampaign(), plan(effects, 10), 15).state.gold).toBe(100);
  });

  it("fires a failure effect only when every attempt failed", () => {
    const effects: PlannedEffect[] = [{ effect: { kind: "setFlag", flag: "alarmed", value: 1 }, when: anyMira(false) }];
    expect(rolled(newCampaign(), plan(effects, 15), 2).state.flags).toEqual({ alarmed: 1 });
    expect(rolled(newCampaign(), plan(effects, 15), 15).state.flags).toBeUndefined();
  });

  it("takes payment from the purse when the hero can afford it, and does nothing when they cannot", () => {
    const paid = rolled({ ...newCampaign(), gold: 50 }, plan([{ effect: { kind: "spendGold", characterId: "c-mira", amount: 20 }, when: always }]), 10);
    expect(paid.state.gold).toBe(30);
    const broke = rolled({ ...newCampaign(), gold: 5 }, plan([{ effect: { kind: "spendGold", characterId: "c-mira", amount: 20 }, when: always }]), 10);
    expect(broke.state.gold).toBe(5);
  });

  it("refuses malformed flags and empty rewards", () => {
    const bad: PlannedEffect[] = [
      { effect: { kind: "setFlag", flag: "Bad Flag", value: 1 }, when: always },
      { effect: reward("empty", 0), when: always },
    ];
    expect(reject(closedRound(), system, { kind: "applyRoundPlan", proposal: plan(bad) })).toMatchObject({ code: "invalidPlan" });
  });
});
