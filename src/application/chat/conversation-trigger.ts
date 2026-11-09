import type { ChatRequest } from "./chat-provider.js";
import { isExplicitInteraction, type ChatInteraction } from "./chat-policy.js";

export interface TriggerResolution {
  interaction: ChatInteraction;
  explicit: boolean;
  responseToEventId: string | null;
  discussedMessageId: string | null;
}

// Transport evidence only. A bare ping can refer to a substantive earlier
// request; this label must never disable tools or decide conversational intent.
export function mentionInteraction(content: string, botId: string, hasImages: boolean): "direct_mention" | "bare_ping" {
  const withoutMention = content.replaceAll(new RegExp(`<@!?${botId}>`, "gu"), "").trim();
  return !hasImages && /^(?:|hi|hey|yo|hello|嗨|嘿|哈囉|[?!？！]+)$/iu.test(withoutMention) ? "bare_ping" : "direct_mention";
}

export function resolveConversationTrigger(request: Pick<ChatRequest, "interaction" | "currentEvent"> & { sourceMessageId?: string | null | undefined }): TriggerResolution {
  return { interaction: request.interaction, explicit: isExplicitInteraction(request.interaction),
    responseToEventId: request.sourceMessageId ?? (request.currentEvent?.type === "message" ? request.currentEvent.messageId : null),
    discussedMessageId: request.currentEvent?.type === "message" ? request.currentEvent.replyToMessageId : null };
}
