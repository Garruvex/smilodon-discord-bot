// Central memory domain model (Plan 1). Supersedes the split
// chat_memories/guild_knowledge representation — see the plan doc for the
// structural gaps that motivated unifying them (isolated-private-memory
// expression, provenance, contradictory-claim loss, duplicated authorization).

import type { ChannelMemoryMode } from "./memory-channel-policy.js";

export type MemoryKind = "fact" | "preference" | "episode";
export type MemoryAudience = "private" | "channel" | "guild";
// npc/faction/location: campaign-lore entities (D&D bot use case) — they
// have no self-report path (see resolveInitialStatus in memory-engine.ts),
// so a live-chat-sourced fact about one stays "candidate" the same way
// team/project facts already do; only consolidation-sourced facts about
// them auto-activate.
export type MemorySubjectType = "member" | "guild" | "team" | "project" | "npc" | "faction" | "location";
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

// Bounded multi-hop relational retrieval (see DefaultMemoryEngine.recall in
// memory-engine.ts). Deliberately a small closed predicate vocabulary, not
// model-invented predicates — validated at the app layer, not a DB
// constraint, matching how kind/status/source are already
// free-text-with-TS-enum rather than DB-enum. General-purpose: connects any
// two existing subjects (member/guild/team/project), nothing here is
// domain-specific.
export type MemoryRelationPredicate =
  | "member_of" | "allied_with" | "hostile_to" | "owes" | "controls" | "located_in" | "owns";

// "association": semantic relatedness only — feeds the hop-weighted recall
// boost. "consequence": directional causal succession (from led to to) —
// additionally rendered as an ordered chain in recall context, not just a
// ranking nudge, since the point of a causal chain is the order. Both use
// the same predicate vocabulary; kind is set at extraction time based on
// whether the source judged the relationship causal or merely associative.
export type MemoryRelationKind = "association" | "consequence";

export interface MemoryRelation {
  id: string;
  guildId: string;
  fromSubjectType: MemorySubjectType;
  fromSubjectId: string;
  predicate: MemoryRelationPredicate;
  kind: MemoryRelationKind;
  toSubjectType: MemorySubjectType;
  toSubjectId: string;
  // Same semantics as Memory.isolationChannelId — see canRecall.
  isolationChannelId: string | null;
  supportingMemoryId: string | null;
  createdAt: number;
}

export interface RelationCreateInput {
  guildId: string;
  fromSubjectType: MemorySubjectType;
  fromSubjectId: string;
  predicate: MemoryRelationPredicate;
  kind: MemoryRelationKind;
  toSubjectType: MemorySubjectType;
  toSubjectId: string;
  isolationChannelId: string | null;
  supportingMemoryId: string | null;
  now: number;
}

export interface RelatedSubjectsQuery {
  guildId: string;
  // The current channel the recall is happening in — matches canRecall's
  // isolationChannelId rule exactly: a relation is visible when its own
  // isolationChannelId is null (global) OR equals this channel. This is
  // NOT the relation's isolationChannelId; it's what gets compared against it.
  channelId: string;
  subjectIds: readonly string[];
  // Bounded iterative BFS depth — see DefaultMemoryEngine's
  // maxRelationHops. Not a recursive SQL CTE (drizzle-orm has no
  // withRecursive support); the repository walks this many rounds of plain
  // per-hop queries in application code instead.
  maxHops: number;
}

export interface RelatedSubject {
  subjectType: MemorySubjectType;
  subjectId: string;
  // 1 = directly connected to one of the query's subjectIds, 2 = connected
  // through one intermediate subject, etc. — used to decay the recall boost
  // the further out a connection is (see checkForConflicts's sibling logic
  // in memory-engine.ts for the general pattern of distance-based weighting
  // in this codebase).
  hopDistance: number;
  kind: MemoryRelationKind;
  predicate: MemoryRelationPredicate;
  // The subject on the other end of the edge that discovered this one —
  // one of query.subjectIds when hopDistance is 1, an intermediate subject
  // otherwise. Lets a caller render the last link of a causal chain
  // ("viaSubjectId --predicate--> subjectId") even though this type doesn't
  // carry the full path back to the original query subjects.
  viaSubjectId: string;
  viaSubjectType: MemorySubjectType;
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
  // Scope of the memory that triggered this lookup — candidates outside
  // this scope must never be returned, or conflict detection ends up
  // comparing (and potentially superseding) memories across the same
  // privacy boundary canRecall enforces on read. Mirrors canRecall's
  // per-audience rule: private only conflicts within the same owner,
  // channel only within the same channel, guild only against other guild
  // memories; isolationChannelId must match exactly on top of that.
  audience: MemoryAudience;
  ownerUserId: string | null;
  channelId: string | null;
  isolationChannelId: string | null;
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
  // Bounded multi-hop relational retrieval support — see memory-engine.ts's
  // DefaultMemoryEngine.recall. Batch, not one-at-a-time: a single
  // consolidation call may extract several relations from one batch of
  // messages.
  createRelations(inputs: readonly RelationCreateInput[]): Promise<void>;
  // Bidirectional bounded BFS out from query.subjectIds, up to
  // query.maxHops rounds — see RelatedSubjectsQuery's doc comment for why
  // this isn't a recursive SQL CTE. Never returns a subject reachable only
  // through a relation whose isolationChannelId doesn't match
  // query.channelId (checked at every hop, not just the final result) —
  // the same privacy boundary canRecall enforces on memories themselves.
  findRelatedSubjects(query: RelatedSubjectsQuery): Promise<readonly RelatedSubject[]>;
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
  // "disabled" means no memory reads or writes at all in this channel (see
  // ChannelMemoryMode) — omitted/other modes recall normally. Optional
  // rather than required so existing callers/tests that don't care about
  // channel isolation aren't forced to thread a mode through.
  channelMode?: ChannelMemoryMode;
  // When true, only memories with a genuine textual/semantic match to
  // `message` are eligible — see DefaultMemoryEngine.recall's
  // topicalMatchMinCosine gate. Ordinary ambient recall (the default,
  // false/omitted) doesn't need this: a little topically-loose extra
  // context in the prompt is harmless. A caller that surfaces results
  // directly as "here's what I found" (see MemoryLookupTool) does — without
  // it, an unrelated query can return the subject's most recent memories
  // purely on recency/subject boost and present them as matches.
  requireTopicalMatch?: boolean;
  // When true, only the caller's own private memories about themselves
  // (audience "private", ownerUserId AND subjectId both userId) are
  // eligible — applied before ranking/budgeting, not as a post-hoc filter
  // on the result. Without this, a broad "what do you remember about me"
  // (see MemoryLookupTool's "list" scope, the only caller) shares the same
  // maxSelectedChars budget as every other eligible guild/channel memory
  // and private note about someone else; those can rank higher (recency,
  // subject boost) and consume the whole budget, crowding out the
  // caller's own memories before a post-hoc filter ever gets a chance to
  // discard them. Scoping the candidate set itself, before
  // selectByRelevance runs, is the only way to guarantee the budget is
  // spent exclusively on memories that were even eligible to answer the
  // question.
  onlySelfPrivateMemories?: boolean;
}

// A 2-node causal chain surfaced by a "consequence" relation reachable
// within one hop of the turn's subjectIds — see DefaultMemoryEngine.recall.
// Deliberately limited to single-hop chains for now: rendering a genuine
// multi-hop chain (origin -> intermediate -> discovered) needs path
// tracking through the relation BFS, which findRelatedSubjects doesn't do
// yet (it returns each subject's closest discovering edge, not the full
// path back to the query's subjectIds) — a scoped-out follow-up, not
// silently dropped.
export interface CausalChainLink {
  fromSubjectType: MemorySubjectType;
  fromSubjectId: string;
  predicate: MemoryRelationPredicate;
  toSubjectType: MemorySubjectType;
  toSubjectId: string;
}

export interface MemoryContext {
  memories: readonly Memory[];
  // Not yet wired into the actual prompt text (buildChatContext/ChatRequest
  // don't consume this) — the data is here for a follow-up to render, not a
  // finished feature. See CausalChainLink's doc comment for the hop-depth
  // limitation.
  causalChains: readonly CausalChainLink[];
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

// A relation proposal from an extraction call (currently: channel-summary
// consolidation only — see the plan's deliberate scope decision against
// continuous per-turn extraction). Subject ids are expected to already be
// resolved (author references etc. expanded), same expectation as
// ProposedMemory's subjectId — the engine validates existence/vocabulary,
// it doesn't resolve references.
export interface ProposedRelation {
  fromSubjectType: MemorySubjectType;
  fromSubjectId: string;
  predicate: MemoryRelationPredicate;
  kind: MemoryRelationKind;
  toSubjectType: MemorySubjectType;
  toSubjectId: string;
}

export interface MemoryRelationIngestInput {
  guildId: string;
  channelId: string;
  channelMode: ChannelMemoryMode;
  proposals: readonly ProposedRelation[];
  // The single fact whose extraction produced this batch of relations —
  // provenance, same sourceMessageId/batch concept as MemoryIngestInput.
  supportingMemoryId: string | null;
  now: number;
}

export interface MemoryRelationIngestResult {
  created: number;
  // Proposals with a dangling subject reference (neither side resolves to
  // a subject id present in this same batch/known to the caller) or an
  // invalid predicate — see channel-summary-scheduler.ts's validation.
  rejected: number;
}

export interface MemoryEngine {
  recall(input: MemoryRecallInput): Promise<MemoryContext>;
  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult>;
  ingestRelations(input: MemoryRelationIngestInput): Promise<MemoryRelationIngestResult>;
  listUserMemories(guildId: string, userId: string): Promise<readonly Memory[]>;
  forget(input: MemoryForgetInput): Promise<number>;
}
