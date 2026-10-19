import type { ChatRequest } from "./chat-provider.js";

export type ConversationInteraction = "direct_mention" | "explicit_reply" | "bare_ping" | "name_address" | "implicit_followup" | "group_conversation" | "reaction";
export interface TriggerResolution {
  interaction: ConversationInteraction;
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

export function resolveConversationTrigger(request: Pick<ChatRequest, "triggerMode" | "interactionMode" | "currentEvent"> & { sourceMessageId?: string | null | undefined }): TriggerResolution {
  const interaction = request.interactionMode ?? ({ direct: "direct_mention", ambient: "name_address", continuation: "implicit_followup", spontaneous: "group_conversation", reaction: "reaction" } as const)[request.triggerMode];
  return { interaction, explicit: request.triggerMode === "direct" || request.triggerMode === "ambient",
    responseToEventId: request.sourceMessageId ?? (request.currentEvent?.type === "message" ? request.currentEvent.messageId : null),
    discussedMessageId: request.currentEvent?.type === "message" ? request.currentEvent.replyToMessageId : null };
}
