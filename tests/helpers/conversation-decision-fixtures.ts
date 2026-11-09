import type { ChannelHistoryMessage, ChatRequest, ChatResponse } from "../../src/application/chat/chat-provider.js";
import type { CharacterDecision } from "../../src/application/chat/character-decision.js";
export function decisionEvent(messageId: string, timestampMs: number, authorId = "alice", extra: Partial<ChannelHistoryMessage> = {}): ChannelHistoryMessage {
  return { messageId, timestampMs, authorId, authorDisplayName: authorId, content: "A specific question about the current game", imageCount: 0, ...extra };
}
export const branchHuman = decisionEvent("original", 1000);
export const branchBot = decisionEvent("confirmed-reply", 2000, "bot", { replyToMessageId: "original", replyToAuthorId: "alice" });
export const branchCurrent = decisionEvent("current", 3000);
export function decisionRequest(extra: Partial<ChatRequest> = {}): ChatRequest {
  return { guildId: "guild", channelId: "channel", personality: "A fictional character", personaLore: [], personaDrift: null, exampleExchanges: [], userCustomization: null,
    currentUser: { id: "alice", displayName: "Alice", roleNames: [] }, mentionedUsers: [], recentHistory: [], memories: [], guildKnowledge: [], causalChains: [],
    message: branchCurrent.content, replyChain: [], replyChainSummary: null, channelHistory: [branchHuman, branchBot], currentBurst: [branchCurrent], birthday: null,
    images: [], webSearchMode: "off", imageGenerationEnabled: false, includeSources: false, interaction: "implicit_followup", botUserId: "bot", ...extra };
}
export function decisionResponse(extra: Partial<ChatResponse> = {}): ChatResponse {
  return { text: "A specific answer", userMemoryActions: [], guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false, generatedImages: [],
    ambientAction: "reply", reactionEmoji: null, historyReactions: [], ...extra };
}
export function decisionProposal(extra: Partial<CharacterDecision> = {}): CharacterDecision {
  return { addressing: "continuing", motivation: 0.9, recipientEvidence: ["current"], recipientConfidence: 0.9, targetConfidence: 0.9,
    contribution: { text: "A specific answer", adds: "Relevant information", label: "answer", motivation: 0.9, sourceMessageId: "current", recipientId: "alice" },
    opening: "clear", boundary: "earlier", target: "current", confidence: 0.9, reaction: null, thoughts: [], ...extra };
}
