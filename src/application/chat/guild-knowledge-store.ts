import type {
  GuildKnowledgeRecord,
} from "./chat-provider.js";
import type { ValidatedGuildKnowledgeCandidate } from "./guild-knowledge-policy.js";

export interface GuildKnowledgeCandidateRecord extends ValidatedGuildKnowledgeCandidate {
  id: string;
  status: "candidate" | "confirmed" | "deprecated";
  source: "self_report" | "community" | "administrator" | "consolidation";
  assertedByUserIds: readonly string[];
  confirmedByUserIds: readonly string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  embedding: number[] | null;
}

// What propose() actually persists per candidate — the statement's
// embedding, computed by the caller (ChatConversationService) since it's a
// network call and stores stay dumb. Null when embeddings aren't configured
// or the embed call failed.
export interface EmbeddedGuildKnowledgeCandidate extends ValidatedGuildKnowledgeCandidate {
  embedding: number[] | null;
}

export interface GuildKnowledgeStore {
  initialize(): Promise<void>;
  // `channelId` scopes the returned set to guild-wide facts (stored
  // channelId === null) plus this channel's own — see
  // guild_knowledge.channelId in schema.ts and the "channel layer" design.
  loadConfirmed(guildId: string, channelId: string): Promise<readonly GuildKnowledgeRecord[]>;
  propose(input: {
    guildId: string;
    // Null for a consolidation-authored batch (no single asserting user) —
    // such candidates are never self-confirmable and land as source
    // "consolidation", same treatment as a third-party community claim.
    assertedByUserId: string | null;
    candidates: readonly EmbeddedGuildKnowledgeCandidate[];
    now: number;
  }): Promise<void>;
}
