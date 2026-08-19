import type {
  GuildKnowledgeRecord,
  ProposedGuildKnowledgeCandidate,
} from "./chat-provider.js";

export interface GuildKnowledgeCandidateRecord extends ProposedGuildKnowledgeCandidate {
  id: string;
  status: "candidate" | "confirmed" | "deprecated";
  source: "self_report" | "community" | "administrator";
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
export interface EmbeddedGuildKnowledgeCandidate extends ProposedGuildKnowledgeCandidate {
  embedding: number[] | null;
}

export interface GuildKnowledgeStore {
  initialize(): Promise<void>;
  loadConfirmed(guildId: string): Promise<readonly GuildKnowledgeRecord[]>;
  propose(input: {
    guildId: string;
    assertedByUserId: string;
    candidates: readonly EmbeddedGuildKnowledgeCandidate[];
    now: number;
  }): Promise<void>;
}
