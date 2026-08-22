// Central memory domain model (Plan 1). Supersedes the split
// chat_memories/guild_knowledge representation — see the plan doc for the
// structural gaps that motivated unifying them (isolated-private-memory
// expression, provenance, contradictory-claim loss, duplicated authorization).

import type { ChannelMemoryMode } from "./memory-channel-policy.js";

export type MemoryKind = "fact" | "preference" | "episode";
export type MemoryAudience = "private" | "channel" | "guild";
export type MemorySubjectType = "member" | "guild" | "team" | "project";
export type MemoryStatus = "candidate" | "active" | "superseded" | "expired";
export type MemorySourceKind = "live" | "explicit" | "administrator" | "consolidation";

export interface Memory {
  id: string;
  guildId: string;
  kind: MemoryKind;
  audience: MemoryAudience;
  ownerUserId: string | null;
  channelId: string | null;
  // One-way leak boundary, independent of `audience` — see canRecall in
  // memory-engine.ts. Non-null means this memory cannot be recalled from any
  // channel other than this one, regardless of audience.
  isolationChannelId: string | null;
  subjectType: MemorySubjectType;
  subjectId: string;
  topic: string;
  slot: string;
  statement: string;
  structuredValue: unknown;
  status: MemoryStatus;
  supersededById: string | null;
  source: MemorySourceKind;
  confidence: number;
  importance: number;
  embedding: readonly number[] | null;
  embeddingModel: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  // Bi-temporal history — see schema.ts's memories table for the rationale.
  // validUntil is null exactly when this row is the current one for its
  // identity (independent of status: "candidate" rows are also current).
  validFrom: number;
  validUntil: number | null;
}

export interface MemorySource {
  id: string;
  memoryId: string;
  sourceMessageId: string | null;
  sourceChannelId: string | null;
  assertedByUserId: string | null;
  // What THIS source actually claimed — may differ from the canonical
  // memory's statement once dedup/consolidation has merged multiple sources.
  statement: string;
  source: MemorySourceKind;
  createdAt: number;
}

// One-way leak boundary + read audience together decide recall eligibility.
// Applied in the repository query (SQL WHERE), before BM25/vector ranking —
// never as a post-filter.
export interface RecallContext {
  guildId: string;
  channelId: string;
  userId: string;
}

export function canRecall(memory: Pick<Memory, "guildId" | "isolationChannelId" | "audience" | "ownerUserId" | "channelId" | "status" | "expiresAt">, context: RecallContext, now: number): boolean {
  if (memory.guildId !== context.guildId) return false;
  if (memory.status !== "active") return false;
  if (memory.expiresAt !== null && memory.expiresAt <= now) return false;
  if (memory.isolationChannelId !== null && memory.isolationChannelId !== context.channelId) return false;
  switch (memory.audience) {
    case "private": return memory.ownerUserId === context.userId;
    case "channel": return memory.channelId === context.channelId;
    case "guild": return true;
  }
}

// --- Repository contract -----------------------------------------------

export interface RepositoryIngestInput {
  guildId: string;
  kind: MemoryKind;
  audience: MemoryAudience;
  ownerUserId: string | null;
  channelId: string | null;
  isolationChannelId: string | null;
  subjectType: MemorySubjectType;
  subjectId: string;
  topic: string;
  slot: string;
  statement: string;
  structuredValue?: unknown;
  status: MemoryStatus;
  source: MemorySourceKind;
  confidence: number;
  importance: number;
  embedding: readonly number[] | null;
  embeddingModel: string | null;
  expiresAt: number | null;
  now: number;
  // Provenance for this ingest — always recorded, even on an update to an
  // existing identity (a new memory_sources row per ingest call).
  sourceMessageId: string | null;
  sourceChannelId: string | null;
  assertedByUserId: string | null;
}

export interface CandidateQuery {
  guildId: string;
  channelId: string;
  userId: string;
  now: number;
  // Optional: narrow to a specific subject (e.g. "what do we know about
  // Bob") — undefined means no subject filter.
  subjectIds?: readonly string[];
}

export interface RecallCandidates {
  // Already authorization-filtered (canRecall) and bounded at the
  // repository/SQL layer. Ranking (BM25 + cosine + RRF, via
  // memory-relevance.ts) happens in the engine, uniformly across backends —
  // the repository's only job is producing the eligible candidate set.
  memories: readonly Memory[];
}

export interface ForgetQuery {
  guildId: string;
  // Either a specific memory id, or all memories owned by a user.
  memoryId?: string;
  ownerUserId?: string;
}

export interface ActiveSubjectQuery {
  guildId: string;
  subjectType: MemorySubjectType;
  subjectId: string;
  // Excludes the row just written by the current ingest call — that
  // identity's own revision is already handled inside ingest() itself (see
  // the isRevision branch in both repository implementations). This query
  // is only for finding OTHER active memories about the same subject.
  excludeMemoryId: string;
}

export interface SupersedeCommand {
  guildId: string;
  memoryId: string;
  supersededById: string;
  now: number;
}

export interface MemoryRepository {
  ingest(input: RepositoryIngestInput): Promise<Memory>;
  findRecallCandidates(input: CandidateQuery): Promise<RecallCandidates>;
  findById(guildId: string, id: string): Promise<Memory | null>;
  listByUser(guildId: string, userId: string): Promise<Memory[]>;
  forget(input: ForgetQuery): Promise<number>;
  // Conflict-at-write support (MOSAIC-style, simplified — see
  // memory-engine.ts's checkForConflicts): every other currently-active
  // memory about the same subject, regardless of topic/slot, so the engine
  // can compare embeddings against a statement that just got written under
  // a different identity than an existing, semantically overlapping one.
  findActiveBySubject(query: ActiveSubjectQuery): Promise<readonly Memory[]>;
  // Closes out a memory found to conflict with a newly-ingested one — same
  // status/validUntil/supersededById transition as ingest()'s own
  // same-identity revision path, just applied across a different identity.
  // Returns false (no-op) if the row was already non-active by the time
  // this runs (e.g. concurrently superseded by something else).
  supersede(command: SupersedeCommand): Promise<boolean>;
}

// --- Engine contract -----------------------------------------------------

export interface MemoryRecallInput {
  guildId: string;
  channelId: string;
  userId: string;
  message: string;
  recentHistory: readonly { content: string }[];
  subjectIds: readonly string[];
  now: number;
}

export interface MemoryContext {
  memories: readonly Memory[];
}

export type ProposedMemory =
  | {
      action: "upsert";
      // Model's requested intent only — "channel" is never requested
      // directly, it's a resolved output of memory-channel-policy.ts's
      // resolveMemoryScope (audience "guild" + channelScoped narrows to it).
      audience: "private" | "guild";
      kind: MemoryKind;
      ownerUserId: string | null;
      subjectType: MemorySubjectType;
      subjectId: string;
      topic: string;
      slot: string;
      statement: string;
      // Model's own guess at whether this should leave the channel — the
      // engine's channel-mode policy may override this, never trusts it
      // blindly in "isolated" mode. See memory-channel-policy.ts.
      channelScoped: boolean;
      // Per-proposal override for MemoryIngestInput.assertedByUserId —
      // undefined means "use the ingest call's own value" (the normal case:
      // one asserting user per live-chat turn). A consolidation batch has no
      // single asserter, so ChannelSummaryScheduler sets this per-proposal
      // from each fact's evidence (see resolveInitialStatus's consolidation
      // branch in memory-engine.ts) — null explicitly means "no self-report
      // evidence found", distinct from "not applicable".
      assertedByUserId?: string | null;
    }
  | {
      action: "remove";
      ownerUserId: string | null;
      subjectType: MemorySubjectType;
      subjectId: string;
      topic: string;
      slot: string;
    };

export interface MemoryIngestInput {
  guildId: string;
  channelId: string;
  // Resolved by the caller (e.g. ChatConversationService, from guild config)
  // and enforced here — the engine never looks up guild configuration
  // itself, keeping this module decoupled from config schema.
  channelMode: ChannelMemoryMode;
  assertedByUserId: string | null;
  sourceMessageId: string | null;
  source: MemorySourceKind;
  proposals: readonly ProposedMemory[];
  now: number;
}

export interface MemoryIngestResult {
  ingested: readonly Memory[];
  removed: number;
  // Proposals that failed validateProposal (bad topic/slot/subject, secret
  // content, etc.) — permanently invalid content; retrying the same batch
  // will not fix these.
  rejected: number;
  // Proposals that passed validation but failed at the repository/embedding
  // layer (transient infra error) — retryable. Background callers (see
  // ChannelSummaryScheduler) must not advance their checkpoint when this is
  // nonzero; interactive chat may still log-and-continue.
  failed: number;
}

export interface MemoryTurnCommit {
  guildId: string;
  channelId: string;
  userId: string;
  userMessage: string;
  assistantMessage: string;
  now: number;
}

export interface MemoryForgetInput {
  guildId: string;
  ownerUserId: string;
  memoryId?: string;
}

export interface MemoryEngine {
  recall(input: MemoryRecallInput): Promise<MemoryContext>;
  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult>;
  listUserMemories(guildId: string, userId: string): Promise<readonly Memory[]>;
  forget(input: MemoryForgetInput): Promise<number>;
}
