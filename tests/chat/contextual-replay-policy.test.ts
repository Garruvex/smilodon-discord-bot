import { describe, expect, it } from "vitest";
import { contextualReplayCases } from "../../src/application/chat/contextual-replay.js";
import type { ContextualReplayCase } from "../../src/application/chat/contextual-replay.js";
import type { DecisionOutcome } from "../../src/application/chat/character-decision.js";
import { replayPolicyAssessment } from "../../src/application/chat/contextual-replay-policy.js";
import { contextualDecisionContract } from "../../src/application/chat/contextual-decision-contract.js";
import { contextualProposal } from "../helpers/contextual-decision-fixtures.js";

const bot = "1000000000000000200";
function fixture(scenario: string, speaker = "same"): ContextualReplayCase {
  return contextualReplayCases().find((item) => item.id === `en-${scenario}-960000-${speaker}`)!;
}
function outcome(scenario: string, extra: Record<string, unknown> = {}, speaker = "same"): DecisionOutcome {
  const item = fixture(scenario, speaker);
  const contract = contextualDecisionContract([...item.events, item.current], bot, item.current.messageId);
  return { status: "valid" as const, attempts: [], decision: contract.parse(contextualProposal({
    recipientEvidence: contract.evidenceSources.map((source) => source.key), ...extra,
  })) };
}
describe("synthetic preflight policy measurement", () => {
  it("measures a real guarded same-person followup after a gap", async () => {
    expect(await replayPolicyAssessment(fixture("answer"), outcome("answer"))).toMatchObject({ action: "reply", status: "ready", requiredReplyMet: true });
  });
  it("reports missing required replies separately from successful silence", async () => {
    expect(await replayPolicyAssessment(fixture("repair"), { status: "failed", decision: null, attempts: [] }))
      .toMatchObject({ status: "failed", action: "silent", textPolicyMet: true, requiredReplyMet: false });
  });
  it("measures policy suppression instead of counting a bad raw followup as delivery", async () => {
    expect(await replayPolicyAssessment(fixture("unknown"), outcome("unknown")))
      .toMatchObject({ status: "denied", action: "silent", textPolicyMet: true });
  });
  it("exposes unsupported group proposals that the prior policy accepted", async () => {
    expect(await replayPolicyAssessment(fixture("unknown"), outcome("unknown", { relationship: "group" })))
      .toMatchObject({ action: "reply", textPolicyMet: false });
  });
  it("retains recipient correction suppression even for a wrong group proposal", async () => {
    expect(await replayPolicyAssessment(fixture("closing"), outcome("closing", { relationship: "group" })))
      .toMatchObject({ action: "silent", reason: "addressed_elsewhere", textPolicyMet: true });
  });
});
