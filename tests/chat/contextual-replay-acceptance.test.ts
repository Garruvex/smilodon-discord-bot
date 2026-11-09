import { describe, expect, it } from "vitest";
import { contextualReplayAcceptance } from "../../src/application/chat/contextual-replay-acceptance.js";
import { contextualReplayCases } from "../../src/application/chat/contextual-replay.js";

describe("contextual replay release gates", () => {
  const successful = (): Parameters<typeof contextualReplayAcceptance>[0][number][] => Array.from({ length: 216 }, () => ({
    status: "valid", durationMs: 5000, expectedMeaning: true, policy: { textPolicyMet: true, requiredReplyMet: true },
  }));
  it("requires sufficient evidence rather than passing a small smoke run", () => {
    expect(contextualReplayAcceptance(successful())).toMatchObject({ passed: true });
    expect(contextualReplayAcceptance(successful().slice(0, 8))).toMatchObject({ sufficientCases: false, passed: false });
  });
  it.each(["meaning", "interruption", "requiredReplies", "latency", "validity", "unmeasured"] as const)("cannot pass from validity alone when %s fails", (failure) => {
    const results = successful();
    if (failure === "meaning") for (const result of results.slice(0, 12)) result.expectedMeaning = false;
    if (failure === "interruption") results[0]!.policy!.textPolicyMet = false;
    if (failure === "requiredReplies") for (const result of results.slice(0, 2)) result.policy!.requiredReplyMet = false;
    if (failure === "latency") for (const result of results.slice(0, 12)) result.durationMs = 13000;
    if (failure === "validity") for (const result of results.slice(0, 3)) result.status = "failed";
    if (failure === "unmeasured") results[0]!.policy = null;
    expect(contextualReplayAcceptance(results).passed).toBe(false);
  });
  it("does not permit another person's bare selection to become a group reply", () => {
    const cases = contextualReplayCases().filter((item) => item.scenario === "answer" && item.id.endsWith("-other"));
    expect(cases).toHaveLength(9);
    expect(cases.every((item) => !item.textAllowed && item.expectedRelationships.join() === "unclear")).toBe(true);
  });
});
