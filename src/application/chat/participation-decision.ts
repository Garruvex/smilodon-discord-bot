import type { ChatResponse } from "./chat-provider.js";

export interface ParticipationDecision {
  action: "silent" | "react" | "reply" | "reply_and_react";
  reason: string | null;
  targetMessageId: string | null;
  expiresAt: number | null;
}
export function participationDecision(response: ChatResponse, targetMessageId: string | null, expiresAt: number | null): ParticipationDecision {
  const reply = response.ambientAction === "reply";
  const react = response.reactionEmoji !== null || response.historyReactions.length > 0;
  return { action: reply ? react ? "reply_and_react" : "reply" : react ? "react" : "silent",
    reason: response.participationReason?.slice(0, 160) ?? null, targetMessageId, expiresAt };
}
