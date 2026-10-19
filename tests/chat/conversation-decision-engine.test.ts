import { describe, expect, it } from "vitest";
import { ConversationDecisionEngine } from "../../src/application/chat/conversation-decision-engine.js";
import { defaultParticipation } from "../../src/application/chat/participation-policy.js";
import { branchHuman, branchBot, branchCurrent, decisionEvent, decisionProposal, decisionRequest, decisionResponse } from "../helpers/conversation-decision-fixtures.js";

const engine = new ConversationDecisionEngine();
const failed = { status: "failed" as const, decision: null, attempts: [] };
const fallback = { ...defaultParticipation, continuationEnabled: true, continuationFailureMode: "grounded_fallback" as const };
describe("conversation decision authority", () => {
  it.each(["direct_mention", "explicit_reply", "bare_ping", "name_address"] as const)("preserves %s without optional scoring", (interactionMode) => {
    const request = decisionRequest({ triggerMode: interactionMode === "name_address" ? "ambient" : "direct", interactionMode });
    const result = engine.assess(request, failed, defaultParticipation, true, 4000, "policy");
    expect(result.result).toMatchObject({ status: "ready", decision: { action: "reply", reasonCode: "explicit_request" } });
  });
  it("requires validated social intent for explicit silence and preserves earlier request references", () => {
    const request = decisionRequest({ triggerMode: "direct", interactionMode: "bare_ping", message: "", allowSilentDirect: true });
    expect(engine.finalize(request, decisionResponse({ ambientAction: "ignore", responseIntent: "answer", referentSourceIds: ["original"] }), 4000).decision).toMatchObject({ action: "reply", responseToEventId: null, referentSourceIds: ["original"], recipientIds: ["alice"] });
    expect(engine.finalize(request, decisionResponse({ text: "", ambientAction: "ignore", responseIntent: "social" }), 4000)).toMatchObject({ status: "ready", decision: { action: "silent", intent: "social" } });
    expect(engine.finalize(request, decisionResponse({ text: "", ambientAction: "ignore" }), 4000)).toMatchObject({ status: "failed", recovery: "error_reply" });
    expect(engine.finalize({ ...request, allowSilentDirect: false }, decisionResponse({ text: "hey", ambientAction: "ignore", responseIntent: "social" }), 4000).decision.action).toBe("reply");
  });
  it("keeps failures distinct from a valid abstention", () => {
    expect(engine.assess(decisionRequest(), failed, defaultParticipation, true, 4000, "policy").result.status).toBe("failed");
    const result = engine.assess(decisionRequest(), { status: "valid", decision: decisionProposal({ opening: "closed" }), attempts: [] }, defaultParticipation, true, 4000, "policy").result;
    expect(result).toMatchObject({ status: "ready", decision: { action: "silent", reasonCode: "opening_not_clear" } });
  });
  it("recovers only a proven same-person continuation behind the flag", () => {
    const result = engine.assess(decisionRequest(), failed, fallback, true, 4000, "policy");
    expect(result.result).toMatchObject({ status: "failed", recovery: "grounded_reply", decision: { action: "reply", responseToEventId: null, referentSourceIds: ["current"] } });
    expect(engine.assess(decisionRequest(), failed, { ...fallback, continuationFailureMode: "strict" }, true, 4000, "policy").result.decision.action).toBe("silent");
    expect(engine.finalize(decisionRequest(), decisionResponse(), 5000, "policy", result.result).decision.decisionId).toBe(result.result.decision.decisionId);
  });
  it.each(["social", "closing", "abstain", "contribute"] as const)("does not turn grounded recovery into %s output", (responseIntent) => {
    const prior = engine.assess(decisionRequest(), failed, fallback, true, 4000, "policy").result;
    const result = engine.finalize(decisionRequest(), decisionResponse({ responseIntent }), 5000, "policy", prior);
    expect(result).toMatchObject({ status: "failed", recovery: "none", decision: { action: "silent", reasonCode: "fallback_requires_answer_or_clarification" } });
  });
  it.each(["new_speaker", "interleaved", "closing", "other_recipient", "expired", "no_proof", "quota", "scope", "spontaneous", "reaction"])("refuses continuation recovery: %s", (reason) => {
    const request = decisionRequest(); let now = 4000;
    if (reason === "new_speaker") { request.currentUser = { ...request.currentUser, id: "bob" }; request.currentBurst = [{ ...branchCurrent, authorId: "bob" }]; }
    if (reason === "interleaved") request.channelHistory = [branchHuman, branchBot, decisionEvent("interloper", 2500, "bob")];
    if (reason === "closing") request.currentBurst = [{ ...branchCurrent, content: "thanks" }];
    if (reason === "other_recipient") request.currentBurst = [{ ...branchCurrent, replyToAuthorId: "bob", replyToMessageId: "another" }];
    if (reason === "expired") now = 140_000;
    if (reason === "no_proof") request.channelHistory = [branchBot];
    if (reason === "quota") request.optionalActionsAvailable = { text: false, reaction: false };
    if (reason === "spontaneous") request.triggerMode = "spontaneous";
    if (reason === "reaction") request.triggerMode = "reaction";
    const result = engine.assess(request, failed, fallback, reason !== "scope", now, "policy").result;
    expect(result.decision.action).toBe("silent"); expect(result.recovery).toBe("none");
  });
  it("rejects unknown evidence in generated output without authorizing a reaction", () => {
    const result = engine.finalize(decisionRequest({ triggerMode: "reaction" }), decisionResponse({ referentSourceIds: ["private-unknown"], reactionEmoji: "😂" }), 4000);
    expect(result).toMatchObject({ status: "failed", recovery: "none", decision: { action: "silent", reasonCode: "invalid_evidence" } });
  });
  it.each(["target", "evidence", "recipient"])("rejects an ungrounded %s even if a caller labels the proposal valid", (kind) => {
    const proposal = decisionProposal({ addressing: "others" });
    if (kind === "target") proposal.target = "unapproved";
    if (kind === "evidence") proposal.recipientEvidence = ["unapproved"];
    if (kind === "recipient") proposal.contribution.recipientId = "unapproved";
    const result = engine.assess(decisionRequest({ triggerMode: "spontaneous" }), { status: "valid", decision: proposal, attempts: [] }, fallback, true, 4000, "policy").result;
    expect(result.status).toBe("failed"); expect(result.decision.action).toBe("silent"); expect(result.recovery).toBe("none");
  });
  it("preserves functional confirmations independently of playful silence", () => {
    expect(engine.finalize(decisionRequest({ triggerMode: "direct", allowSilentDirect: true, functionalToolExecuted: true }), decisionResponse({ ambientAction: "ignore", responseIntent: "social" }), 4000).decision).toMatchObject({ action: "reply", reasonCode: "functional_confirmation" });
  });
});
