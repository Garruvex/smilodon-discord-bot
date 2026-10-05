import { describe, expect, it } from "vitest";

import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { performRoll } from "../../../src/domain/campaign/dice/roll-spec.js";
import type { CampaignState } from "../../../src/domain/campaign/state/campaign-state.js";
import { alex, jamie, newCampaign, organizer, reject, run, system } from "./campaign-fixtures.js";

// A short rest opens the chance to spend Hit Dice; each die is rolled, the Constitution modifier is added, and the dice are spent.

const hurt = (): CampaignState => {
  const base = newCampaign();
  return { ...base, heroStatus: { ...base.heroStatus, "c-borin": { hp: 1, resources: { spellSlots: {}, featureUses: {} } } } };
};
const rested = (): CampaignState => run(hurt(), organizer, { kind: "takeRest", rest: "short" }).state;

describe("spending Hit Dice on a short rest", () => {
  it("is only open after a short rest, and only for the hero's own player", () => {
    expect(reject(hurt(), jamie, { kind: "spendHitDice", characterId: "c-borin", count: 1 })).toEqual({ code: "noShortRest" });
    expect(reject(rested(), alex, { kind: "spendHitDice", characterId: "c-borin", count: 1 })).toEqual({ code: "notYourCharacter" });
  });

  it("asks for the dice and the Constitution bonus, and changes nothing until they land", () => {
    const asked = run(rested(), jamie, { kind: "spendHitDice", characterId: "c-borin", count: 1 });
    const pending = asked.state.hitDicePending?.["c-borin"];
    expect(pending?.expression.terms).toEqual([{ count: 1, sides: 10 }]);
    expect(asked.state.heroStatus["c-borin"]?.hp).toBe(1);
    expect(reject(asked.state, jamie, { kind: "spendHitDice", characterId: "c-borin", count: 1 })).toEqual({ code: "hitDicePending" });
  });

  it("heals by the roll, spends the dice, and refuses more than the hero has", () => {
    const asked = run(rested(), jamie, { kind: "spendHitDice", characterId: "c-borin", count: 1 });
    const request = asked.requests.find((candidate) => candidate.kind === "roll");
    const pending = asked.state.hitDicePending?.["c-borin"];
    if (request?.kind !== "roll" || pending === undefined) throw new Error("no roll asked for");
    const result = performRoll(request.spec, new SeededRandomSource(5));
    const settled = run(asked.state, system, { kind: "recordRoll", rollId: pending.rollId, result });
    const status = settled.state.heroStatus["c-borin"];
    expect(status?.hitDice).toBe(0);
    expect(status?.hp).toBe(Math.min(12, 1 + Math.max(0, result.kind === "dice" ? result.roll.total : 0)));
    expect(settled.state.hitDicePending?.["c-borin"]).toBeUndefined();
    expect(settled.requests).toContainEqual(expect.objectContaining({ kind: "deliver", delivery: expect.objectContaining({ kind: "hitDiceSettled", characterId: "c-borin", count: 1 }) }));
    expect(reject(settled.state, jamie, { kind: "spendHitDice", characterId: "c-borin", count: 1 })).toEqual({ code: "noHitDice" });
  });

  it("closes when the next round opens", () => {
    const next = run(rested(), system, { kind: "openRound" }).state;
    expect(reject(next, jamie, { kind: "spendHitDice", characterId: "c-borin", count: 1 })).toEqual({ code: "noShortRest" });
  });
});
