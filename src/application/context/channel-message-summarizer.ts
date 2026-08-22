import type { ProposedGuildKnowledgeCandidate } from "../chat/chat-provider.js";
import type { MemoryRelationKind, MemoryRelationPredicate, MemorySubjectType } from "../memory/memory.js";

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

// Bounded multi-hop relational retrieval's write path (see
// DefaultMemoryEngine.recall) — general-purpose, no domain-specific
// concept. Subject ids are already resolved (author references expanded)
// by the time this reaches the caller, same as ChannelSummaryFact.
// Provenance (which fact/evidence backs this relation) isn't carried here —
// the scheduler attaches a single supportingMemoryId for the whole batch,
// not per-relation.
export interface ChannelSummaryRelation {
  fromSubjectType: MemorySubjectType;
  fromSubjectId: string;
  predicate: MemoryRelationPredicate;
  kind: MemoryRelationKind;
  toSubjectType: MemorySubjectType;
  toSubjectId: string;
}

// Named distinctly from channel-message-summarization.ts's own
// ChannelMessageSummary (the raw zod-inferred model output shape, still
// keyed by author/message references) — this is the resolved shape after
// prepareChannelMessageSummary's parse() has expanded those references,
// same relationship ChannelSummaryFact already has to the raw fact shape.
export interface ChannelSummaryResult {
  facts: readonly ChannelSummaryFact[];
  relations: readonly ChannelSummaryRelation[];
}

/** Focused model capability consumed by channel-context processing. */
export interface ChannelMessageSummarizer {
  summarizeChannelMessages(
    guildId: string,
    messages: readonly ChannelSummaryMessage[],
  ): Promise<ChannelSummaryResult>;
}
