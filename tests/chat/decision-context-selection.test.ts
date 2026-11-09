import { describe, expect, it } from "vitest";
import { selectDecisionContext } from "../../src/application/chat/decision-context-selection.js";
import { branchHuman, branchBot, branchCurrent, decisionEvent, decisionRequest } from "../helpers/conversation-decision-fixtures.js";
describe("authorized decision context projection", () => {
  it("preserves an older human/bot exchange before filling the recent tail", () => {
    const tail = Array.from({ length: 20 }, (_, index) => decisionEvent(`tail-${index}`, 4000 + index, "bob"));
    const request = decisionRequest({ channelHistory: [branchHuman, branchBot, ...tail], currentBurst: [{ ...branchCurrent, timestampMs: 1_000_000, content: "好了嗎" }] });
    const selected = selectDecisionContext(request, 6);
    expect(selected.events.map((event) => event.messageId)).toEqual(["original", "confirmed-reply", "tail-16", "tail-17", "tail-18", "tail-19"]);
    expect(selected.coverage).toEqual({ available: 22, selected: 6, required: 2, omittedRequired: 0 });
  });
  it("preserves authorized explicit ancestry and reports essential underfill", () => {
    const request = decisionRequest({ channelHistory: [], replyChain: [branchHuman, branchBot] });
    expect(selectDecisionContext(request, 1).coverage.omittedRequired).toBe(1);
  });
  it("never invents a referenced source or a missing exchange dependency", () => {
    const request = decisionRequest({ message: "1560000000000000001", channelHistory: [branchBot], currentBurst: [{ ...branchCurrent, content: "1560000000000000001" }] });
    const selected = selectDecisionContext(request, 4);
    expect(selected.events.map((event) => event.messageId)).toEqual(["confirmed-reply"]);
    expect(selected.coverage.required).toBe(0);
  });
});
