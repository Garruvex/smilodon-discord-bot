import { describe, expect, it } from "vitest";
import { budgetEligibleHistory } from "../../src/application/chat/eligible-channel-history.js";
import type { ChannelHistoryMessage } from "../../src/application/chat/chat-provider.js";

const event = (id: number, content = "hello"): ChannelHistoryMessage => ({ messageId: `m${id}`, authorId: "human", channelId: "channel",
  authorDisplayName: "Human", timestampMs: id, content, imageCount: 0, replyToMessageId: "target" });

describe("history prompt budget", () => {
  it("keeps all count candidates verbatim whenever the complete set fits", () => {
    const events = [event(1, "x".repeat(1200)), event(2), event(3)];
    expect(budgetEligibleHistory(events, 40, 2200)).toMatchObject({ messages: events, truncated: 0, budgetOmitted: 0 });
  });

  it("retains older small messages when a recent message is oversized, preserving attribution and links", () => {
    const result = budgetEligibleHistory([event(1), event(2), event(3, "x".repeat(100_000))], 40, 2000);
    expect(result.messages.map((message) => message.messageId)).toEqual(["m1", "m2", "m3"]);
    expect(result.messages.at(-1)).toMatchObject({ authorId: "human", timestampMs: 3, replyToMessageId: "target" });
    expect(result.messages.reduce((total, message) => total + JSON.stringify(message).length, 0)).toBeLessThanOrEqual(2000);
    expect(result.truncated).toBe(1);
  });

  it("counts unique messages, preserves long gaps, and applies count separately from size", () => {
    const old = event(1); const latest = event(100_000_000);
    expect(budgetEligibleHistory([old, old, latest], 40, 2000).messages).toEqual([old, latest]);
    expect(budgetEligibleHistory([old, latest], 1, 2000)).toMatchObject({ messages: [latest], countOmitted: 1 });
    expect(budgetEligibleHistory([old], 0, 2000).messages).toEqual([]);
  });

  it("budgets escaped content and never emits a blank fragment of an oversized metadata record", () => {
    const result = budgetEligibleHistory([event(1, '"\\'.repeat(2000)), { ...event(2), authorDisplayName: "x".repeat(4000) }], 40, 1000);
    expect(result.messages.map((message) => message.messageId)).toEqual(["m1"]);
    expect(JSON.stringify(result.messages[0]).length).toBeLessThanOrEqual(1000);
    expect(result.budgetOmitted).toBe(1);
  });
});
