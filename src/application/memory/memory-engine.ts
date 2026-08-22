import type { Logger } from "pino";

import type { EmbeddingsClient } from "../../infrastructure/chat/openai-embeddings-client.js";
import { allowsDurableWrites, resolveMemoryScope } from "./memory-channel-policy.js";
import type {
  Memory,
  MemoryContext,
  MemoryEngine,
  MemoryForgetInput,
  MemoryIngestInput,
  MemoryIngestResult,
  MemoryRecallInput,
  MemoryRepository,
  ProposedMemory,
} from "./memory.js";
import { canRecall } from "./memory.js";
import { memoryValidationLimits, validateProposal, type MemoryValidationLimits } from "./memory-validation.js";
import {
  bm25Score,
  buildBm25Corpus,
  buildRelevanceContext,
  cosineSimilarity,
  reciprocalRankFusion,
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
}

export const defaultMemoryEngineLimits: MemoryEngineLimits = {
  maxSelectedChars: 8_000,
  conflictSimilarityThreshold: 0.75,
  ...memoryValidationLimits,
};

function toScorable(memory: Memory): ScorableRecord {
  return { subjectId: memory.subjectId, topic: memory.topic, slot: memory.slot, statement: memory.statement, updatedAt: memory.updatedAt };
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
  ) {}

  public async recall(input: MemoryRecallInput): Promise<MemoryContext> {
    const candidates = await this.repository.findRecallCandidates({
      guildId: input.guildId, channelId: input.channelId, userId: input.userId, now: input.now,
    });
    if (candidates.memories.length === 0) return { memories: [] };
    const subjectIds = new Set(input.subjectIds);
    const context = buildRelevanceContext({ message: input.message, recentHistory: input.recentHistory, subjectIds, now: input.now });
    const scorableByMemory = new Map(candidates.memories.map((memory) => [memory, toScorable(memory)] as const));
    const corpus = buildBm25Corpus([...scorableByMemory.values()]);
    const lexicalOrder = [...candidates.memories].sort(
      (a, b) => bm25Score(corpus, context, scorableByMemory.get(b)!) - bm25Score(corpus, context, scorableByMemory.get(a)!),
    );
    let embeddingOrder = lexicalOrder;
    if (this.embeddingsClient) {
      const queryEmbedding = await this.embeddingsClient.embed(input.message).catch(() => null);
      if (queryEmbedding) {
        embeddingOrder = [...candidates.memories].sort((a, b) =>
          cosineSimilarity(b.embedding ?? [], queryEmbedding) - cosineSimilarity(a.embedding ?? [], queryEmbedding));
      }
    }
    const fused = reciprocalRankFusion([lexicalOrder, embeddingOrder]);
    const selected = selectByRelevance(
      candidates.memories,
      (memory) => fused.get(memory) ?? 0,
      this.limits.maxSelectedChars,
      memoryPromptProjection,
    );
    return { memories: selected };
  }

  public async ingest(input: MemoryIngestInput): Promise<MemoryIngestResult> {
    if (!allowsDurableWrites(input.channelMode)) return { ingested: [], removed: 0, rejected: 0, failed: 0 };
    const ingested: Memory[] = [];
    let removed = 0;
    let rejected = 0;
    let failed = 0;
    for (const proposal of input.proposals) {
      const validated = validateProposal(proposal, this.limits);
      if (!validated) { rejected += 1; continue; }
      if (validated.proposal.action === "remove") {
        removed += await this.removeOne(input.guildId, validated.proposal);
        continue;
      }
      const memory = await this.upsertOne(input, validated.proposal, validated.topic, validated.slot, validated.statement!);
      if (memory) ingested.push(memory);
      else failed += 1;
    }
    return { ingested, removed, rejected, failed };
  }

  private async removeOne(guildId: string, proposal: Extract<ProposedMemory, { action: "remove" }>): Promise<number> {
    if (proposal.ownerUserId === null) return 0;
    const owned = await this.repository.listByUser(guildId, proposal.ownerUserId);
    const match = owned.find((memory) =>
      memory.subjectType === proposal.subjectType && memory.subjectId === proposal.subjectId &&
      memory.topic === proposal.topic && memory.slot === proposal.slot);
    if (!match) return 0;
    return this.repository.forget({ guildId, memoryId: match.id });
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
    let memory: Memory;
    try {
      memory = await this.repository.ingest({
        guildId: input.guildId,
        kind: proposal.kind,
        audience: scope.audience,
        ownerUserId: proposal.audience === "private" ? proposal.ownerUserId : null,
        channelId: scope.channelId,
        isolationChannelId: scope.isolationChannelId,
        subjectType: proposal.subjectType,
        subjectId: proposal.subjectId,
        topic,
        slot,
        statement,
        status,
        source: input.source,
        confidence: 1,
        importance: 1,
        embedding,
        embeddingModel: embedding ? "default" : null,
        expiresAt: null,
        now: input.now,
        sourceMessageId: input.sourceMessageId,
        sourceChannelId: input.channelId,
        assertedByUserId,
      });
    } catch (error) {
      this.logger?.warn({ error, guildId: input.guildId }, "Memory ingest failed for one proposal");
      return null;
    }
    if (memory.status === "active" && memory.embedding) {
      await this.checkForConflicts(memory, input.now);
    }
    return memory;
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
      });
    } catch (error) {
      this.logger?.warn({ error, guildId: memory.guildId }, "Conflict lookup failed; leaving related memories as-is");
      return;
    }
    const embedding = memory.embedding!;
    for (const candidate of related) {
      if (!candidate.embedding) continue;
      if (cosineSimilarity(embedding, candidate.embedding) < this.limits.conflictSimilarityThreshold) continue;
      try {
        await this.repository.supersede({ guildId: memory.guildId, memoryId: candidate.id, supersededById: memory.id, now });
      } catch (error) {
        this.logger?.warn({ error, guildId: memory.guildId }, "Failed to supersede a conflicting memory");
      }
    }
  }

  public listUserMemories(guildId: string, userId: string): Promise<readonly Memory[]> {
    return this.repository.listByUser(guildId, userId);
  }

  public forget(input: MemoryForgetInput): Promise<number> {
    if (input.memoryId) return this.repository.forget({ guildId: input.guildId, memoryId: input.memoryId });
    return this.repository.forget({ guildId: input.guildId, ownerUserId: input.ownerUserId });
  }
}

// Re-exported for callers that need the pure predicate without constructing
// an engine (e.g. tests) — see memory.ts.
export { canRecall };
