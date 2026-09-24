import type { Logger } from "pino";

import type { MemoryConflictClassifier } from "../chat/chat-provider.js";
import type { EmbeddingsClient } from "../chat/embeddings-client.js";
import { allowsDurableWrites, resolveMemoryScope } from "./memory-channel-policy.js";
import type { MemoryRelevanceTraceCollector } from "./memory-relevance-trace.js";
import type {
  CausalChainLink,
  Memory,
  MemoryContext,
  MemoryEngine,
  MemoryForgetInput,
  MemoryIngestInput,
  MemoryIngestResult,
  MemoryRecallInput,
  MemoryRelationIngestInput,
  MemoryRelationIngestResult,
  MemoryRepository,
  MemorySource,
  ProposedMemory,
  RelationCreateInput,
} from "./memory.js";
import { canRecall } from "./memory.js";
import { memoryValidationLimits, validateProposal, type MemoryValidationLimits } from "./memory-validation.js";
import {
  bm25LexicalScore,
  bm25Score,
  buildBm25Corpus,
  buildEmbeddingQueryText,
  buildRelevanceContext,
  cosineSimilarity,
  reciprocalRankFusion,
  rrfK,
  selectByRelevance,
  type ScorableRecord,
} from "../chat/memory-relevance.js";

export interface MemoryEngineLimits extends MemoryValidationLimits {
  // Shared prompt-injection budget across every memory kind/audience — the
  // legacy split (chatMemoryLimits.maxSelectedChars for private,
  // guildKnowledgeLimits.maxSerializedChars for guild) collapses into one
  // budget now that recall goes through a single ranked list.
  maxSelectedChars: number;
  // Conflict-at-write (MOSAIC, arXiv:2607.16211, simplified — see
  // checkForConflicts below): cosine-similarity cutoff above which a new
  // active memory is treated as superseding an existing one about the same
  // subject. This is a proxy for "probably the same underlying fact stated
  // under a different topic/slot," not real contradiction detection —
  // cosine similarity alone can't distinguish a restatement from a negation
  // ("likes apples" vs "hates apples" score similarly high, since they're
  // the same topic/lexical field).
  //
  // MUST be tuned to the actual configured embedding model — cosine-
  // similarity baselines are not portable across embedding models.
  // Published/community-reported ranges as of this writing (not measured
  // against this app's own data — treat as a starting point):
  //   - OpenAI text-embedding-3-small/large (this app's documented default,
  //     see schema.ts's embeddingDimensions comment): a much lower, more
  //     spread-out baseline than older OpenAI models — community guidance
  //     puts ~0.45 as a reasonable "related" cutoff (e.g. "apple"/"orange"
  //     score ~0.45-0.47), so a near-duplicate/same-fact threshold should
  //     sit well above that but is very unlikely to reach the 0.9+ range
  //     that older-model intuition suggests.
  //   - OpenAI text-embedding-ada-002 (legacy): high baseline anisotropy —
  //     even unrelated sentence pairs commonly score >0.68, reportedly up to
  //     ~0.82 for some unrelated pairs — so a 0.9+ threshold is closer to
  //     right for this model, but false positives are still a real risk.
  //   - Gemini gemini-embedding-001/text-embedding-004 (this app's other
  //     supported provider, see gemini-embeddings-client.ts's
  //     SEMANTIC_SIMILARITY task type): normalized, MRL-based vectors
  //     explicitly tuned for this kind of comparison; no reliable published
  //     baseline was found during this review, so the default below is a
  //     conservative guess, not a sourced number.
  // The default here targets text-embedding-3-small (the app's documented
  // default) at a conservative multiple of the "related" baseline —
  // recalibrate via MEMORY_CONFLICT_SIMILARITY_THRESHOLD if the deployment
  // uses a different model, and prefer measuring actual same-fact vs.
  // different-fact pairs from real data over trusting this number.
  conflictSimilarityThreshold: number;
  // Identity canonicalization at write time (see upsertOne's
  // canonicalizeIdentity) — the cosine-similarity bar a NEW proposal's
  // embedding must clear against an existing active memory about the same
  // subject (any topic/slot) to be treated as literally the same fact and
  // rewritten onto that memory's identity, rather than creating a
  // fragmented duplicate under its own model-invented slot. Deliberately
  // well above conflictSimilarityThreshold: that threshold only asks "is
  // this worth flagging as a possible conflict" (with an optional LLM
  // classifier as a further check before acting); this one commits to
  // "these ARE the same identity" with no further confirmation step, so it
  // needs much higher confidence to avoid merging two genuinely different
  // facts that merely share a topical/lexical field. Same embedding-model-
  // dependent caveat as its sibling constant applies — recalibrate via
  // MEMORY_IDENTITY_CANONICALIZATION_THRESHOLD per deployment rather than
  // trusting this as a validated value.
  identityCanonicalizationThreshold: number;
  // Bounded relational retrieval (see recall's relatedSubjectBoosts) — how
  // many hops out from the turn's subjectIds to search. The worked example
  // that motivated this (a fact tying a character to a consequence two
  // relations away) needed 2; kept small and tunable rather than hardcoded
  // to 1, since a flat single-hop expansion demonstrably wasn't enough for
  // its own justifying example.
  maxRelationHops: number;
  // Weight of the graph-proximity signal, in RRF units: a memory whose
  // subject sits `hop` relations from the conversation (hop 0 = one of the
  // turn's own subjects) gains relationBoostWeight / (k + hop + 1) — exactly
  // what ranking #(hop + 1) in one more RRF list would earn. At the default
  // of 1, being connected is worth about as much as topping one of the
  // lexical/embedding rankings: enough to matter, never enough to bury a
  // strong textual match the way an unscaled additive boost would.
  relationBoostWeight: number;
  // How long an unconfirmed "candidate" (a claim about someone other than
  // the speaker) lives before it's deleted if nobody corroborates it — see
  // corroborate().
  candidateTtlMs: number;
}

export const defaultMemoryEngineLimits: MemoryEngineLimits = {
  maxSelectedChars: 8_000,
  conflictSimilarityThreshold: 0.75,
  identityCanonicalizationThreshold: 0.92,
  maxRelationHops: 2,
  relationBoostWeight: 1,
  candidateTtlMs: 30 * 24 * 60 * 60 * 1_000,
  ...memoryValidationLimits,
};

// Caps how many conflict-classifier calls (see shouldSupersede) a single
// ingested memory can trigger. findActiveBySubject can return up to 50
// same-scope candidates, and every one clearing the similarity threshold
// would otherwise get its own classifier round-trip — for a busy subject
// (or a consolidation batch ingesting many proposals about the same
// subject at once) that fans out into dozens-to-hundreds of extra LLM
// calls per ingest. Only the most-similar candidates are worth spending
// that budget on; the rest fall back to the pre-classifier, safe-by-default
// behavior (coexist rather than supersede) same as when no classifier is
// configured at all.
const maxConflictClassificationsPerMemory = 5;

// Gate for MemoryRecallInput.requireTopicalMatch (see recall() below) — the
// minimum cosine similarity to the query embedding that counts as a genuine
// semantic match, when a memory has no lexical (BM25) overlap with the
// query at all. Deliberately conservative: this only needs to exclude
// memories recall would otherwise include purely on subject/recency boost,
// not to second-guess embedding similarity once it clears a real floor.
const topicalMatchMinCosine = 0.25;

function toScorable(memory: Memory): ScorableRecord {
  return {
    subjectId: memory.subjectId, topic: memory.topic, slot: memory.slot, statement: memory.statement,
    updatedAt: memory.updatedAt, importance: memory.importance,
  };
}

// Never sends the embedding vector itself to the model — same exclusion as
// the legacy selectors' prompt projections.
function memoryPromptProjection(memory: Memory): unknown {
  const { embedding: _embedding, ...rest } = memory;
  return rest;
}

// Topics/subjects allowed to self-activate straight to "active" without
// human confirmation — a member asserting something about themselves.
// A claim about someone else starts as "candidate". Mirrors the legacy
// maySelfConfirm's intent, simplified: this pass doesn't carry over the
// legacy per-topic allowlist (selfConfirmingGuildTopics) — see follow-up
// note in the plan.
//
// Consolidation (channel-summary) trust rules (Plan 2, Phase 5): guild/
// team/project facts are community-level, not personal claims about
// someone — active once validated, same as before. A member-subject fact
// is different: it's a claim ABOUT a specific person, so it only
// self-activates when that person is the one who said it (assertedByUserId
// here is ChannelSummaryScheduler's per-fact evidence-derived asserter —
// see resolveEvidence — not the batch-level null). A claim about a member
// made by someone else in the batch stays "candidate" regardless of
// source; letting consolidation blanket-trust every member fact just
// because the subject participated somewhere in the channel would let a
// third party's claim about someone become durable, active memory with no
// confirmation from the subject at all.
//
// A candidate doesn't wait forever: it becomes active once a second,
// independent asserter makes the same claim (see corroborate()), and is
// deleted after limits.candidateTtlMs if nobody does.
function resolveInitialStatus(
  audience: "private" | "channel" | "guild",
  subjectType: Memory["subjectType"],
  subjectId: string,
  assertedByUserId: string | null,
  source: Memory["source"],
): Memory["status"] {
  if (audience === "private") return "active";
  if (source === "consolidation" && subjectType !== "member") return "active";
  if (assertedByUserId !== null && subjectType === "member" && subjectId === assertedByUserId) return "active";
  return "candidate";
}

export class DefaultMemoryEngine implements MemoryEngine {
  public constructor(
    private readonly repository: MemoryRepository,
    private readonly embeddingsClient: EmbeddingsClient | null = null,
    private readonly logger: Logger | null = null,
    private readonly limits: MemoryEngineLimits = defaultMemoryEngineLimits,
    // Optional: a provider may not implement this capability (see
    // Partial<MemoryConflictClassifier> on ChatProvider) — checkForConflicts
    // falls back to the similarity threshold alone when absent, same
    // behavior as before this existed.
    private readonly conflictClassifier: Partial<MemoryConflictClassifier> | null = null,
    // Explicitly opt-in evaluation capture. The collector receives only the
    // candidate set this recall was already authorized to read; failures are
    // logged and never fail the user-facing recall.
    private readonly relevanceTraceCollector: Pick<MemoryRelevanceTraceCollector, "record" | "includePrivate"> | null = null,
  ) {}

  public async recall(input: MemoryRecallInput): Promise<MemoryContext> {
    if (input.channelMode === "disabled") return { memories: [], causalChains: [] };
    // onlySelfPrivateMemories bypasses findRecallCandidates entirely rather
    // than filtering its output: that query mixes every audience together
    // (private-of-caller, channel, guild) under one shared
    // maxEligibleCandidates cap with no ordering guarantee (see the
    // repositories' own comments on that limit) — in a busy guild, the
    // caller's own private memories can simply not be among the rows that
    // cap returns, so a post-hoc filter would still come back empty even
    // though the memories genuinely exist. repository.listByUser has no
    // such cap: it's already scoped to one owner, so its size is bounded by
    // that user's own memory count, not the guild's. It doesn't filter
    // isolationChannelId/expiresAt/status itself (unlike
    // findRecallCandidates), so those are re-applied here in JS.
    const candidates = input.onlySelfPrivateMemories
      ? {
          memories: (await this.repository.listByUser(input.guildId, input.userId)).filter((memory) =>
            memory.audience === "private" && memory.subjectId === input.userId && memory.status === "active" &&
            (memory.isolationChannelId === null || memory.isolationChannelId === input.channelId) &&
            (memory.expiresAt === null || memory.expiresAt > input.now)),
        }
      : await this.repository.findRecallCandidates({
          guildId: input.guildId, channelId: input.channelId, userId: input.userId, now: input.now,
          // Ordering hint only (see CandidateQuery.prioritySubjectIds) —
          // never subjectIds, which would narrow the eligible set down to
          // just these subjects instead of merely preferring them when the
          // cap has to drop something.
          prioritySubjectIds: input.subjectIds,
        });
    if (candidates.memories.length === 0) return { memories: [], causalChains: [] };
    const { boostBySubjectId, causalChains } = await this.expandRelatedSubjects(input);
    const subjectIds = new Set(input.subjectIds);
    const context = buildRelevanceContext({ message: input.message, recentHistory: input.recentHistory, subjectIds, now: input.now });
    const scorableByMemory = new Map(candidates.memories.map((memory) => [memory, toScorable(memory)] as const));
    const corpus = buildBm25Corpus([...scorableByMemory.values()]);
    const bm25ScoreByMemory = new Map(candidates.memories.map(
      (memory) => [memory, bm25Score(corpus, context, scorableByMemory.get(memory)!)] as const,
    ));
    // Separate from bm25ScoreByMemory above: that score has subject/recency
    // boost baked in (see bm25Score), so it's never 0 for a record about
    // someone in the conversation, whatever the query. This is the pure
    // term-overlap component alone — the actual "topically related at all"
    // signal used by the requireTopicalMatch gate below.
    const lexicalOverlapByMemory = new Map(candidates.memories.map(
      (memory) => [memory, bm25LexicalScore(corpus, context, scorableByMemory.get(memory)!)] as const,
    ));
    const lexicalOrder = [...candidates.memories].sort(
      (a, b) => bm25ScoreByMemory.get(b)! - bm25ScoreByMemory.get(a)!,
    );
    // Only memories with an embedding comparable to the query's participate
    // in this ranking. cosineSimilarity returns 0 for a missing embedding
    // AND for a dimension mismatch (e.g. a memory stored under a previous,
    // differently-sized embedding model) — neither is a real "not similar"
    // signal. Without this filter they'd all tie at the bottom and get
    // spread across consecutive ranks by array order alone, handing some of
    // them RRF credit they didn't earn on relevance.
    let embeddingOrder: readonly Memory[] = [];
    const cosineByMemory = new Map<Memory, number>();
    if (this.embeddingsClient) {
      const queryText = buildEmbeddingQueryText({
        message: input.message, recentHistory: input.recentHistory, replyToContent: input.replyToContent,
      });
      const queryEmbedding = await this.embeddingsClient.embed(queryText).catch(() => null);
      if (queryEmbedding) {
        const withCosine = candidates.memories
          .filter((memory) => memory.embedding && memory.embedding.length === queryEmbedding.length)
          .map((memory) => [memory, cosineSimilarity(memory.embedding!, queryEmbedding)] as const);
        for (const [memory, score] of withCosine) cosineByMemory.set(memory, score);
        embeddingOrder = [...withCosine].sort((a, b) => b[1] - a[1]).map(([memory]) => memory);
      }
    }
    const fused = reciprocalRankFusion(embeddingOrder.length > 0 ? [lexicalOrder, embeddingOrder] : [lexicalOrder]);
    // Graph proximity, already in RRF units (see relationBoostWeight) so it
    // adds to the fused score on the same scale instead of swamping it.
    // Only "association" relations reach here; "consequence" relations feed
    // causalChains instead (see expandRelatedSubjects), since a causal chain
    // needs to be read in order, not just used to nudge a score.
    if (boostBySubjectId.size > 0) {
      for (const memory of candidates.memories) {
        const boost = boostBySubjectId.get(memory.subjectId);
        if (boost) fused.set(memory, (fused.get(memory) ?? 0) + boost);
      }
    }
    // requireTopicalMatch (see MemoryLookupTool) gates on a genuine textual/
    // semantic signal rather than the fused score alone — that score folds
    // in subject/recency boosts (buildRelevanceContext/boostBySubjectId
    // above), which make almost any of the subject's memories nonzero
    // regardless of whether the query is actually about them. Ordinary
    // ambient recall doesn't opt into this: a little topically-loose extra
    // context in the prompt is harmless, but a tool that tells the user
    // "here's what I found" needs those results to actually be about what
    // was asked.
    const eligible = input.requireTopicalMatch
      ? candidates.memories.filter((memory) =>
          (lexicalOverlapByMemory.get(memory) ?? 0) > 0 || (cosineByMemory.get(memory) ?? 0) >= topicalMatchMinCosine)
      : candidates.memories;
    const selected = selectByRelevance(
      eligible,
      (memory) => fused.get(memory) ?? 0,
      this.limits.maxSelectedChars,
      memoryPromptProjection,
    );
    if (this.relevanceTraceCollector) {
      const traceableMemories = this.relevanceTraceCollector.includePrivate
        ? candidates.memories
        : candidates.memories.filter((memory) => memory.audience !== "private");
      const traceableIds = new Set(traceableMemories.map((memory) => memory.id));
      await this.relevanceTraceCollector.record({
        guildId: input.guildId,
        channelId: input.channelId,
        message: input.message,
        recentHistory: input.recentHistory.map((item) => item.content),
        subjectIds: input.subjectIds,
        now: input.now,
        candidates: traceableMemories.map((memory) => ({
          id: memory.id,
          ...toScorable(memory),
          serializedChars: JSON.stringify(memoryPromptProjection(memory)).length,
          ...(cosineByMemory.has(memory) ? { cosineSimilarity: cosineByMemory.get(memory)! } : {}),
          ...(boostBySubjectId.has(memory.subjectId)
            ? { relationBoost: boostBySubjectId.get(memory.subjectId)! }
            : {}),
        })),
        selectedIds: selected.filter((memory) => traceableIds.has(memory.id)).map((memory) => memory.id),
        maxSerializedChars: this.limits.maxSelectedChars,
        requireTopicalMatch: input.requireTopicalMatch ?? false,
      }).catch((error: unknown) => {
        this.logger?.warn({ error, guildId: input.guildId }, "Memory relevance trace collection failed");
      });
    }
    return { memories: selected, causalChains };
  }

  // Bounded multi-hop expansion out from the turn's subjectIds — see
  // MemoryEngineLimits.maxRelationHops. "association" relations become a
  // decayed ranking boost (closer connections weighted higher);
  // "consequence" relations become an explicit ordered chain instead,
  // since the point of a causal link is the sequence, not just relatedness.
  // Never a second, separately-authorized fetch: this only influences
  // ranking/annotation of memories findRecallCandidates already authorized
  // — it can't surface a memory that call wouldn't already have allowed.
  private async expandRelatedSubjects(
    input: MemoryRecallInput,
  ): Promise<{ boostBySubjectId: Map<string, number>; causalChains: readonly CausalChainLink[] }> {
    const boostBySubjectId = new Map<string, number>();
    const causalChains: CausalChainLink[] = [];
    if (input.subjectIds.length === 0) return { boostBySubjectId, causalChains };
    let related: readonly Awaited<ReturnType<MemoryRepository["findRelatedSubjects"]>>[number][];
    try {
      related = await this.repository.findRelatedSubjects({
        guildId: input.guildId, channelId: input.channelId, subjectIds: input.subjectIds,
        maxHops: this.limits.maxRelationHops,
      });
    } catch (error) {
      this.logger?.warn({ error, guildId: input.guildId }, "Related-subject lookup failed; recall proceeds without relational boost");
      return { boostBySubjectId, causalChains };
    }
    for (const subject of related) {
      if (subject.kind === "consequence") {
        // The BFS walks edges both ways; a causal link is still read in its
        // stored direction (from led to to), whichever end found it.
        const via = { type: subject.viaSubjectType, id: subject.viaSubjectId };
        const found = { type: subject.subjectType, id: subject.subjectId };
        const [from, to] = subject.edgePointsToVia ? [found, via] : [via, found];
        causalChains.push({
          fromSubjectType: from.type, fromSubjectId: from.id,
          predicate: subject.predicate,
          toSubjectType: to.type, toSubjectId: to.id,
        });
        continue;
      }
      const boost = this.proximityBoost(subject.hopDistance);
      if (boost > (boostBySubjectId.get(subject.subjectId) ?? 0)) boostBySubjectId.set(subject.subjectId, boost);
    }
    // The turn's own subjects are the graph's hop 0. Without this, a memory
    // about someone merely connected to the speaker would outrank the
    // speaker's own memories on proximity alone.
    if (boostBySubjectId.size > 0) {
      for (const subjectId of input.subjectIds) boostBySubjectId.set(subjectId, this.proximityBoost(0));
    }
    return { boostBySubjectId, causalChains };
  }

  // See MemoryEngineLimits.relationBoostWeight.
  private proximityBoost(hopDistance: number): number {
    return this.limits.relationBoostWeight / (rrfK + hopDistance + 1);
  }

  public async ingest(input: MemoryIngestInput): Promise<MemoryIngestResult> {
    if (!allowsDurableWrites(input.channelMode)) return { ingested: [], removed: 0, rejected: 0, failed: 0 };
    // Candidate TTL sweep, piggybacked on writes rather than a separate
    // scheduler: expired candidates are never read (recall only serves
    // active rows), so they only need to be gone before the next write that
    // might dedup or corroborate against them.
    await this.repository.deleteExpiredCandidates(input.guildId, input.now).catch((error: unknown) => {
      this.logger?.warn({ error, guildId: input.guildId }, "Expired-candidate sweep failed");
    });
    const ingested: Memory[] = [];
    let removed = 0;
    let rejected = 0;
    let failed = 0;
    for (const proposal of input.proposals) {
      const validated = validateProposal(proposal, this.limits);
      if (!validated) { rejected += 1; continue; }
      if (validated.proposal.action === "remove") {
        removed += await this.removeOne(input.guildId, validated.proposal, validated.topic, validated.slot);
        continue;
      }
      const memory = await this.upsertOne(input, validated.proposal, validated.topic, validated.slot, validated.statement!);
      if (memory) ingested.push(memory);
      else failed += 1;
    }
    return { ingested, removed, rejected, failed };
  }

  // Relation-specific ingest, separate from ingest() above — relations
  // aren't Memory rows (no statement/status/embedding lifecycle), so they
  // don't fit MemoryIngestInput's proposal shape. Scope resolution (guild
  // audience, isolation) reuses the exact same resolveMemoryScope logic
  // regular facts already go through, so a relation extracted from the same
  // consolidation batch as a fact gets the same isolation boundary.
  public async ingestRelations(input: MemoryRelationIngestInput): Promise<MemoryRelationIngestResult> {
    if (!allowsDurableWrites(input.channelMode)) return { created: 0, rejected: input.proposals.length };
    const scope = resolveMemoryScope(input.channelMode, input.channelId, { audience: "guild", channelScoped: true });
    const valid: RelationCreateInput[] = [];
    let rejected = 0;
    for (const proposal of input.proposals) {
      if (!proposal.fromSubjectId || !proposal.toSubjectId) { rejected += 1; continue; }
      if (proposal.fromSubjectType === proposal.toSubjectType && proposal.fromSubjectId === proposal.toSubjectId) {
        rejected += 1; continue; // a relation to itself carries no information
      }
      valid.push({
        guildId: input.guildId,
        fromSubjectType: proposal.fromSubjectType,
        fromSubjectId: proposal.fromSubjectId,
        predicate: proposal.predicate,
        kind: proposal.kind,
        toSubjectType: proposal.toSubjectType,
        toSubjectId: proposal.toSubjectId,
        isolationChannelId: scope.isolationChannelId,
        supportingMemoryId: input.supportingMemoryId,
        now: input.now,
      });
    }
    if (valid.length === 0) return { created: 0, rejected };
    let created: number;
    try {
      // Already-known edges are skipped by the repository, so `created`
      // counts genuinely new ones only.
      created = await this.repository.createRelations(valid);
    } catch (error) {
      this.logger?.warn({ error, guildId: input.guildId }, "Relation ingest failed");
      return { created: 0, rejected: rejected + valid.length };
    }
    return { created, rejected };
  }

  private async removeOne(
    guildId: string,
    proposal: Extract<ProposedMemory, { action: "remove" }>,
    topic: string,
    slot: string,
  ): Promise<number> {
    if (proposal.ownerUserId === null) return 0;
    const owned = await this.repository.listByUser(guildId, proposal.ownerUserId);
    // Compare against the normalized topic/slot (validateProposal's output),
    // not proposal.topic/proposal.slot directly — ingested memories are
    // always stored normalized (see upsertOne), so matching on the raw,
    // un-normalized proposal fields would silently miss any casing/
    // whitespace difference and discard the removal.
    const match = owned.find((memory) =>
      memory.subjectType === proposal.subjectType && memory.subjectId === proposal.subjectId &&
      memory.topic === topic && memory.slot === slot);
    if (!match) return 0;
    return this.repository.forget({ guildId, memoryId: match.id, ownerUserId: proposal.ownerUserId });
  }

  private async upsertOne(
    input: MemoryIngestInput,
    proposal: Extract<ProposedMemory, { action: "upsert" }>,
    topic: string,
    slot: string,
    statement: string,
  ): Promise<Memory | null> {
    const scope = resolveMemoryScope(input.channelMode, input.channelId, {
      audience: proposal.audience,
      channelScoped: proposal.channelScoped,
    });
    // proposal.assertedByUserId overrides the ingest-level value when
    // present (including explicitly null) — see ProposedMemory's upsert
    // variant for why: a consolidation batch has no single asserter, so
    // ChannelSummaryScheduler resolves one per fact from its evidence.
    const assertedByUserId = proposal.assertedByUserId !== undefined ? proposal.assertedByUserId : input.assertedByUserId;
    const status = resolveInitialStatus(scope.audience, proposal.subjectType, proposal.subjectId, assertedByUserId, input.source);
    const embedding = this.embeddingsClient ? await this.embeddingsClient.embed(statement).catch(() => null) : null;
    const ownerUserId = proposal.audience === "private" ? proposal.ownerUserId : null;
    // Canonicalize BEFORE writing, not after: findActiveBySubject/embedding
    // are already being computed here for the write itself, so reusing them
    // to check "does an existing memory about this subject already mean
    // this?" costs one extra query, not a whole extra pass. See
    // canonicalizeIdentity's own comment for why this needs to happen
    // pre-ingest rather than relying on checkForConflicts alone.
    const canonical = embedding
      ? await this.canonicalizeIdentity({
          guildId: input.guildId, subjectType: proposal.subjectType, subjectId: proposal.subjectId,
          audience: scope.audience, ownerUserId, channelId: scope.channelId, isolationChannelId: scope.isolationChannelId,
          embedding, topic, slot,
        })
      : { topic, slot };
    let memory: Memory;
    try {
      memory = await this.repository.ingest({
        guildId: input.guildId,
        kind: proposal.kind,
        audience: scope.audience,
        ownerUserId,
        channelId: scope.channelId,
        isolationChannelId: scope.isolationChannelId,
        subjectType: proposal.subjectType,
        subjectId: proposal.subjectId,
        topic: canonical.topic,
        slot: canonical.slot,
        statement,
        status,
        source: input.source,
        importance: proposal.importance ?? 1,
        embedding,
        embeddingModel: embedding ? "default" : null,
        expiresAt: status === "candidate" ? input.now + this.limits.candidateTtlMs : null,
        now: input.now,
        sourceMessageId: input.sourceMessageId,
        sourceChannelId: input.channelId,
        assertedByUserId,
      });
    } catch (error) {
      this.logger?.warn({ error, guildId: input.guildId }, "Memory ingest failed for one proposal");
      return null;
    }
    if (memory.status === "candidate") {
      memory = (await this.corroborate(memory, assertedByUserId, input.now)) ?? memory;
    }
    if (memory.status === "active" && memory.embedding) {
      await this.checkForConflicts(memory, input.now);
    }
    return memory;
  }

  // Candidate promotion: a claim about someone becomes active once a second,
  // independent person has made the same claim under the same identity —
  // two witnesses, rather than trusting any single third party. "Same
  // claim" is deliberately strict (identical wording, or embeddings at the
  // identity-canonicalization bar): corroboration commits with no further
  // check, and a looser bar would let "likes pizza" confirm "hates pizza"
  // (same topic, similar embedding). Returns the promoted memory, or null
  // when there's nothing to promote.
  private async corroborate(memory: Memory, assertedByUserId: string | null, now: number): Promise<Memory | null> {
    if (assertedByUserId === null) return null;
    let others: Awaited<ReturnType<MemoryRepository["findCandidatesByIdentity"]>>;
    try {
      others = await this.repository.findCandidatesByIdentity({
        guildId: memory.guildId, ownerUserId: memory.ownerUserId, channelId: memory.channelId,
        isolationChannelId: memory.isolationChannelId, subjectType: memory.subjectType, subjectId: memory.subjectId,
        topic: memory.topic, slot: memory.slot, excludeMemoryId: memory.id, now,
      });
    } catch (error) {
      this.logger?.warn({ error, guildId: memory.guildId }, "Candidate corroboration lookup failed; leaving it a candidate");
      return null;
    }
    const corroborating = others.filter(({ memory: other, assertedByUserIds }) =>
      assertedByUserIds.some((asserter) => asserter !== assertedByUserId) && this.isSameClaim(memory, other));
    if (corroborating.length === 0) return null;
    try {
      return await this.repository.promoteCandidate({
        guildId: memory.guildId, memoryId: memory.id,
        absorbedMemoryIds: corroborating.map(({ memory: other }) => other.id), now,
      });
    } catch (error) {
      this.logger?.warn({ error, guildId: memory.guildId }, "Candidate promotion failed; leaving it a candidate");
      return null;
    }
  }

  private isSameClaim(a: Memory, b: Memory): boolean {
    const normalize = (statement: string): string => statement.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalize(a.statement) === normalize(b.statement)) return true;
    return a.embedding !== null && b.embedding !== null &&
      cosineSimilarity(a.embedding, b.embedding) >= this.limits.identityCanonicalizationThreshold;
  }

  // Finds an existing active memory about the same subject (any topic/
  // slot — findActiveBySubject deliberately ignores both, see its own doc
  // comment) whose statement is close enough in embedding space to be the
  // SAME underlying fact, just named differently by the model at
  // extraction time (`slot` is free text the model invents per call — see
  // MemoryEngineLimits.identityCanonicalizationThreshold). When found, the
  // new proposal is rewritten onto that memory's (topic, slot) identity so
  // it goes through ingest's ordinary same-identity revision path — one
  // coherent statement history under one identity, not a fragmented
  // duplicate that only checkForConflicts might later notice and link via
  // supersede (a weaker outcome: two disconnected memory rows rather than
  // one). Runs pre-ingest, so there's no real memory id yet to exclude from
  // the lookup — excludeMemoryId: "" matches nothing, since every real id
  // is a non-empty randomUUID.
  private async canonicalizeIdentity(input: {
    guildId: string;
    subjectType: Memory["subjectType"];
    subjectId: string;
    audience: Memory["audience"];
    ownerUserId: string | null;
    channelId: string | null;
    isolationChannelId: string | null;
    embedding: readonly number[];
    topic: string;
    slot: string;
  }): Promise<{ topic: string; slot: string }> {
    const fallback = { topic: input.topic, slot: input.slot };
    let candidates: readonly Memory[];
    try {
      candidates = await this.repository.findActiveBySubject({
        guildId: input.guildId, subjectType: input.subjectType, subjectId: input.subjectId,
        excludeMemoryId: "",
        audience: input.audience, ownerUserId: input.ownerUserId, channelId: input.channelId,
        isolationChannelId: input.isolationChannelId,
      });
    } catch (error) {
      this.logger?.warn({ error, guildId: input.guildId }, "Identity canonicalization lookup failed; proceeding with the model's own topic/slot");
      return fallback;
    }
    let best: { memory: Memory; similarity: number } | null = null;
    for (const candidate of candidates) {
      if (!candidate.embedding) continue;
      const similarity = cosineSimilarity(input.embedding, candidate.embedding);
      if (similarity < this.limits.identityCanonicalizationThreshold) continue;
      if (!best || similarity > best.similarity) best = { memory: candidate, similarity };
    }
    return best ? { topic: best.memory.topic, slot: best.memory.slot } : fallback;
  }

  // Only reached for a freshly-active memory with an embedding — a
  // "candidate" (unconfirmed third-party claim) intentionally coexists with
  // others under the same subject until someone confirms it, so it's never
  // compared here. See conflictDetection's threshold comment for what this
  // heuristic can and can't tell apart.
  private async checkForConflicts(memory: Memory, now: number): Promise<void> {
    let related: readonly Memory[];
    try {
      related = await this.repository.findActiveBySubject({
        guildId: memory.guildId, subjectType: memory.subjectType, subjectId: memory.subjectId,
        excludeMemoryId: memory.id,
        audience: memory.audience, ownerUserId: memory.ownerUserId, channelId: memory.channelId,
        isolationChannelId: memory.isolationChannelId,
      });
    } catch (error) {
      this.logger?.warn({ error, guildId: memory.guildId }, "Conflict lookup failed; leaving related memories as-is");
      return;
    }
    const embedding = memory.embedding!;
    const aboveThreshold: { candidate: Memory; similarity: number }[] = [];
    for (const candidate of related) {
      if (!candidate.embedding) continue;
      // Deterministic tie-break, evaluated identically from either side:
      // only the side that sorts later (by createdAt, then id) may
      // supersede the other. Without this, two memories ingested
      // concurrently can each see the other as still-active and both call
      // supersede on each other — leaving neither active. Comparing the
      // same two values in both directions means exactly one direction
      // ever proceeds, regardless of which one's checkForConflicts runs
      // first.
      const memoryIsLater = memory.createdAt !== candidate.createdAt
        ? memory.createdAt > candidate.createdAt
        : memory.id > candidate.id;
      if (!memoryIsLater) continue;
      const similarity = cosineSimilarity(embedding, candidate.embedding);
      if (similarity < this.limits.conflictSimilarityThreshold) continue;
      aboveThreshold.push({ candidate, similarity });
    }
    // Only classify the most-similar candidates — see
    // maxConflictClassificationsPerMemory's comment. Anything beyond the cap
    // is left alone rather than classified, the same safe-by-default outcome
    // as a classifier declining to confirm a conflict. No cap when there's
    // no classifier to fan out calls to in the first place — the pure
    // similarity-threshold path was never the expensive one.
    aboveThreshold.sort((a, b) => b.similarity - a.similarity);
    const toEvaluate = this.conflictClassifier?.classifyMemoryConflict
      ? aboveThreshold.slice(0, maxConflictClassificationsPerMemory)
      : aboveThreshold;
    for (const { candidate } of toEvaluate) {
      if (!(await this.shouldSupersede(candidate, memory))) continue;
      try {
        await this.repository.supersede({ guildId: memory.guildId, memoryId: candidate.id, supersededById: memory.id, now });
      } catch (error) {
        this.logger?.warn({ error, guildId: memory.guildId }, "Failed to supersede a conflicting memory");
      }
    }
  }

  // The embedding threshold above is only a pre-filter — it can't tell a
  // restatement/contradiction of the same fact apart from a merely
  // topically-similar, unrelated one. Two different fallbacks, deliberately
  // not the same value: no classifier configured is a normal, static
  // deployment state, so it behaves exactly as this feature did before the
  // classifier existed (trust the threshold, supersede). An actual
  // classification failure is an unexpected runtime error, so it fails safe
  // toward NOT superseding — an uncertain guess shouldn't silently hide a
  // memory the classifier never actually confirmed was the same fact; the
  // worst case is two memories coexisting a bit longer, not one disappearing.
  private async shouldSupersede(candidate: Memory, memory: Memory): Promise<boolean> {
    if (!this.conflictClassifier?.classifyMemoryConflict) return true;
    try {
      return await this.conflictClassifier.classifyMemoryConflict(candidate.statement, memory.statement);
    } catch (error) {
      this.logger?.warn({ error, guildId: memory.guildId }, "Conflict classification failed; leaving both memories active rather than guessing");
      return false;
    }
  }

  public listUserMemories(guildId: string, userId: string): Promise<readonly Memory[]> {
    return this.repository.listByUser(guildId, userId);
  }

  public listSources(memoryId: string): Promise<readonly MemorySource[]> {
    return this.repository.findSources(memoryId);
  }

  public forget(input: MemoryForgetInput): Promise<number> {
    if (input.memoryId) {
      return this.repository.forget({ guildId: input.guildId, memoryId: input.memoryId, ownerUserId: input.ownerUserId });
    }
    return this.repository.forget({
      guildId: input.guildId, ownerUserId: input.ownerUserId,
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
      ...(input.assertedByUserId !== undefined ? { assertedByUserId: input.assertedByUserId } : {}),
    });
  }
}

// Re-exported for callers that need the pure predicate without constructing
// an engine (e.g. tests) — see memory.ts.
export { canRecall };
