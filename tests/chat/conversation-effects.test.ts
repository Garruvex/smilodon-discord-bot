import { describe, expect, it } from "vitest";
import { authorizeConversationEffects, conversationEffects } from "../../src/application/chat/conversation-effects.js";
import { ConversationDecisionEngine } from "../../src/application/chat/conversation-decision-engine.js";
import { decisionRequest, decisionResponse } from "../helpers/conversation-decision-fixtures.js";

describe("approved conversation effects", () => {
  it.each(["silent", "react", "reply", "reply_and_react"] as const)("permits only the finalized %s effects", (action) => {
    const response = decisionResponse({ reactionEmoji: "👍", historyReactions: [{ messageId: "original", emoji: "🎉" }], characterMessages: ["draft"], characterDelayMs: 10 });
    const decision = new ConversationDecisionEngine().finalize(decisionRequest({ interaction: "direct_mention" }), response, 3000);
    decision.decision.action = action; response.conversationDecision = decision;
    const effects = authorizeConversationEffects(response, "source");
    expect(response.text !== "").toBe(action === "reply" || action === "reply_and_react");
    expect(effects.reactionEmoji !== null).toBe(action === "react" || action === "reply_and_react");
    if (action === "silent" || action === "react") expect(response.characterMessages).toBeUndefined();
    if (action === "silent" || action === "reply") expect(effects.historyReactions).toEqual([]);
  });
  it.each(["missing", "denied", "failed"] as const)("fails closed for a %s decision even when response fields request effects", (status) => {
    const response = decisionResponse({ reactionEmoji: "👍" });
    if (status !== "missing") {
      response.conversationDecision = new ConversationDecisionEngine().finalize(decisionRequest({ interaction: "direct_mention" }), response, 3000);
      response.conversationDecision.status = status;
    }
    expect(conversationEffects(response)).toBeNull();
    expect(authorizeConversationEffects(response, "source")).toMatchObject({ action: "silent", reactionEmoji: null });
    expect(response.text).toBe("");
  });
  it("does not let later raw-field or array mutation change the approved snapshot", () => {
    const response = decisionResponse({ reactionEmoji: "👍", historyReactions: [{ messageId: "original", emoji: "🎉" }] });
    response.conversationDecision = new ConversationDecisionEngine().finalize(decisionRequest({ interaction: "direct_mention" }), response, 3000);
    const effects = authorizeConversationEffects(response, "source");
    response.reactionEmoji = "👎"; response.historyReactions[0]!.emoji = "👎";
    expect(conversationEffects(response)).toBe(effects);
    expect(effects).toMatchObject({ reactionEmoji: "👍", historyReactions: [{ emoji: "🎉" }] });
    expect(Object.isFrozen(effects.historyReactions[0])).toBe(true);
  });
});
