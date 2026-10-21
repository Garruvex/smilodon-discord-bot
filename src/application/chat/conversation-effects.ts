import type { ChatResponse } from "./chat-provider.js";
import type { ValidatedConversationDecision } from "./conversation-decision-engine.js";

export interface ApprovedConversationEffects {
  readonly action: ValidatedConversationDecision["action"];
  readonly targetMessageId: string | null;
  readonly reactionEmoji: string | null;
  readonly historyReactions: readonly Readonly<{ messageId: string; emoji: string }>[];
}
const approved = new WeakMap<ChatResponse, ApprovedConversationEffects>();

// Application executor only, after finalization. Discord adapters consume the
// immutable effect snapshot rather than model-authored response fields.
export function authorizeConversationEffects(response: ChatResponse, sourceMessageId: string | null): ApprovedConversationEffects {
  const result = response.conversationDecision;
  const permitted = result && (result.status === "ready" || result.status === "failed" && result.recovery === "grounded_reply");
  const action = permitted ? result.decision.action : "silent";
  const text = action === "reply" || action === "reply_and_react";
  const reaction = action === "react" || action === "reply_and_react";
  if (!text) { response.text = ""; response.generatedImages = []; delete response.characterMessages; delete response.characterDelayMs; }
  if (!reaction) { response.reactionEmoji = null; response.historyReactions = []; }
  response.ambientAction = text ? "reply" : "ignore";
  const targetMessageId = permitted ? result.decision.responseToEventId ?? sourceMessageId : null;
  if (targetMessageId) response.replyTargetMessageId = targetMessageId;
  else delete response.replyTargetMessageId;
  const effects: ApprovedConversationEffects = Object.freeze({ action, targetMessageId, reactionEmoji: response.reactionEmoji,
    historyReactions: Object.freeze(response.historyReactions.map((item) => Object.freeze({ ...item }))) });
  approved.set(response, effects);
  return effects;
}
export function conversationEffects(response: ChatResponse): ApprovedConversationEffects | null { return approved.get(response) ?? null; }
