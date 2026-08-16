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
}

export interface GuildKnowledgeStore {
  initialize(): Promise<void>;
  loadConfirmed(guildId: string): Promise<readonly GuildKnowledgeRecord[]>;
  propose(input: {
    guildId: string;
    assertedByUserId: string;
    candidates: readonly ProposedGuildKnowledgeCandidate[];
    now: number;
  }): Promise<void>;
}
