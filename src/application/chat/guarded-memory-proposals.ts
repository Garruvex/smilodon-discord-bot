import type { ChatRequest, ChatResponse } from "./chat-provider.js";
import type { ProposedMemory } from "../memory/memory.js";
import { normalizeForGroundingCheck, validateMemoryActions } from "./chat-memory-policy.js";
import { validateGuildKnowledgeCandidates } from "./guild-knowledge-policy.js";

export function guardedMemoryProposals(request: ChatRequest, response: ChatResponse): ProposedMemory[] {
  const events = [...request.replyChain, ...request.channelHistory, ...(request.currentBurst ?? []),
    { authorId: request.currentUser.id, messageId: request.currentEvent?.type === "message" ? request.currentEvent.messageId : "", content: request.message,
      timestampMs: request.currentEvent?.type === "message" ? request.currentEvent.timestampMs : 0 }];
  const humans = events.filter((event) => event.authorId !== request.botUserId);
  const allowed = new Set(humans.map((event) => event.authorId));
  const quoteSource = (quote: string | null, authorId?: string): typeof humans[number] | undefined => {
    const normalized = normalizeForGroundingCheck(quote ?? "");
    return normalized ? humans.find((event) => (!authorId || event.authorId === authorId) && normalizeForGroundingCheck(event.content).includes(normalized)) : undefined;
  };
  const personal: ProposedMemory[] = validateMemoryActions(response.userMemoryActions, allowed).flatMap((action): ProposedMemory[] => {
    if (action.action === "remove") return action.subjectUserId === request.currentUser.id ? [{ action: "remove", ownerUserId: action.subjectUserId,
      subjectType: "member", subjectId: action.subjectUserId, topic: action.topic, slot: action.slot }] : [];
    const source = quoteSource(action.sourceQuote, action.subjectUserId);
    return source && action.statement ? [{ action: "upsert", audience: "private", kind: action.topic === "preference" ? "preference" : "fact",
      ownerUserId: action.subjectUserId, subjectType: "member", subjectId: action.subjectUserId, topic: action.topic, slot: action.slot,
      statement: action.statement, channelScoped: true, assertedByUserId: source.authorId, sourceMessageId: source.messageId,
      sourceTimestampMs: source.timestampMs, sourceQuote: action.sourceQuote }] : [];
  });
  const community: ProposedMemory[] = validateGuildKnowledgeCandidates(response.guildKnowledgeCandidates, { guildId: request.guildId,
    currentChannelId: request.channelId, currentUserId: request.currentUser.id, allowedMemberIds: allowed }).flatMap((candidate): ProposedMemory[] => {
    const source = quoteSource(candidate.sourceQuote);
    return source ? [{ action: "upsert", audience: "guild", kind: candidate.topic === "scene_summary" ? "episode" : "fact", ownerUserId: null, subjectType: candidate.subjectType, subjectId: candidate.subjectId,
      topic: candidate.topic, slot: candidate.slot, statement: candidate.statement, channelScoped: true,
      assertedByUserId: source.authorId, sourceMessageId: source.messageId, sourceTimestampMs: source.timestampMs, sourceQuote: candidate.sourceQuote }] : [];
  });
  return [...personal, ...community];
}
