import { describe, expect, it, vi } from "vitest";
import { budgetEligibleHistory, collectEligibleHistory } from "../../src/application/chat/eligible-channel-history.js";
import type { ChannelHistoryMessage } from "../../src/application/chat/chat-provider.js";

const page = (start: number, size = 100): { id: string }[] => Array.from({ length: size }, (_, index) => ({ id: `m${start - index}` }));
const event = (id: number, content = "hello"): ChannelHistoryMessage => ({ messageId: `m${id}`, authorId: "human", channelId: "channel",
  authorDisplayName: "Human", timestampMs: id, content, imageCount: 0, replyToMessageId: "target" });

describe("count-first eligible channel history", () => {
  it("pages past excluded authors and reply overlap without consuming the eligible count", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(page(300)).mockResolvedValueOnce(page(200));
    const { messages, coverage } = await collectEligibleHistory({ requested: 40, before: "current", excludeIds: new Set(["m200"]), fetchPage,
      authorize: (message) => Promise.resolve(Number(message.id.slice(1)) > 200 ? "ineligible" : null) });
    expect(messages).toHaveLength(40);
    expect(messages[0]!.id).toBe("m160"); expect(messages.at(-1)!.id).toBe("m199");
    expect(fetchPage.mock.calls).toEqual([["current", 100], ["m201", 100]]);
    expect(coverage).toMatchObject({ requested: 40, fetched: 200, examined: 141, eligible: 40, pages: 2, status: "filled",
      omissions: { ineligible: 100, excluded: 1 } });
  });

  it("bounds an entirely unreadable channel to three pages and 300 raw messages", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(page(300)).mockResolvedValueOnce(page(200)).mockResolvedValueOnce(page(100));
    const result = await collectEligibleHistory({ requested: 40, before: null, excludeIds: new Set(), fetchPage,
      authorize: () => Promise.resolve("ineligible") });
    expect(result.messages).toEqual([]);
    expect(result.coverage).toMatchObject({ status: "scan_cap", fetched: 300, pages: 3 });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it.each(["end", "fetch_failed", "no_progress"] as const)("reports %s distinctly and preserves already authorized messages", async (status) => {
    const fetchPage = vi.fn().mockResolvedValueOnce(page(300));
    if (status === "fetch_failed") fetchPage.mockRejectedValueOnce(new Error("PRIVATE_TRANSPORT_BODY"));
    else fetchPage.mockResolvedValueOnce(status === "end" ? [] : page(300));
    const result = await collectEligibleHistory({ requested: 40, before: null, excludeIds: new Set(), fetchPage,
      authorize: (message) => Promise.resolve(message.id === "m300" ? null : "ineligible") });
    expect(result.messages.map((message) => message.id)).toEqual(["m300"]);
    expect(result.coverage.status).toBe(status);
    expect(JSON.stringify(result.coverage)).not.toContain("PRIVATE");
  });

  it("fails closed on an authorization exception", async () => {
    const result = await collectEligibleHistory({ requested: 1, before: null, excludeIds: new Set(),
      fetchPage: () => Promise.resolve([{ id: "secret" }]), authorize: () => Promise.reject(new Error("SECRET")) });
    expect(result.messages).toEqual([]); expect(result.coverage.omissions.ineligible).toBe(1);
  });
});

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
