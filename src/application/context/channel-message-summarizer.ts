import type { ProposedGuildKnowledgeCandidate } from "../chat/chat-provider.js";

export interface ChannelSummaryMessage {
  id: string;
  authorId: string;
  authorDisplayName: string;
  content: string;
}

// A channel-summary fact carries evidence (which input message ids support
// it) that a live-chat-turn candidate doesn't need — the whole point of
// consolidating many authors' messages into one call is that no single
// "asserting user" exists for the batch, so trust has to be derived per
// fact instead (see ChannelSummaryScheduler.resolveEvidence and
// memory-engine.ts's resolveInitialStatus consolidation branch).
export interface ChannelSummaryFact extends Omit<ProposedGuildKnowledgeCandidate, "channelScoped"> {
  // Message ids from the input batch that support this fact. For a
  // subjectType=member fact, only self-report (the subject's own message
  // among these) makes it eligible for "active" status — a claim evidenced
  // only by someone else's message stays a "candidate". Validated against
  // the actual batch by the caller; ids not present in the batch are
  // dropped before trust is resolved.
  evidenceMessageIds: readonly string[];
}

/** Focused model capability consumed by channel-context processing. */
export interface ChannelMessageSummarizer {
  summarizeChannelMessages(
    guildId: string,
    messages: readonly ChannelSummaryMessage[],
  ): Promise<readonly ChannelSummaryFact[]>;
}
