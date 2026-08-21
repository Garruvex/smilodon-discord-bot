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
} from "./memory.js";
import { canRecall } from "./memory.js";
import { validateProposal } from "./memory-validation.js";
import {
  bm25Score,
  buildBm25Corpus,
  buildRelevanceContext,
  cosineSimilarity,
  reciprocalRankFusion,
  selectByRelevance,
  type ScorableRecord,
} from "../chat/memory-relevance.js";

// Shared prompt-injection budget across every memory kind/audience — the
// legacy split (chatMemoryLimits.maxSelectedChars for private,
// guildKnowledgeLimits.maxSerializedChars for guild) collapses into one
// budget now that recall goes through a single ranked list.
export const memoryRecallLimits = {
  maxSelectedChars: 8_000,
} as const;

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
// note in the plan. Consolidation self-activates: there's no "asserter" to
// require agreement from — it's the bot's own summary of a channel event,
// not a claim about a person — so requiring assertedByUserId to match a
// subject (which is never true for it; consolidation always passes
// assertedByUserId: null) would make every consolidated summary
// permanently stuck as an unrecallable candidate.
function resolveInitialStatus(
  audience: "private" | "channel" | "guild",
  subjectType: Memory["subjectType"],
  subjectId: string,
  assertedByUserId: string | null,
  source: Memory["source"],
): Memory["status"] {
  if (audience === "private") return "active";
  if (source === "consolidation") return "active";
  if (assertedByUserId !== null && subjectType === "member" && subjectId === assertedByUserId) return "active";
  return "candidate";
}

export class DefaultMemoryEngine implements MemoryEngine {
  public constructor(
    private readonly repository: MemoryRepository,
    private readonly embeddingsClient: EmbeddingsClient | null = null,
    private readonly logger: Logger | null = null,
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
      memoryRecallLimits.maxSelectedChars,
      memoryPromptProjection,
    );
    return { memories: selected };
  }

  public async ingest(input: MemoryIngestInput): Promise<MemoryIngestResult> {
    if (!allowsDurableWrites(input.channelMode)) return { ingested: [], removed: 0 };
    const ingested: Memory[] = [];
    let removed = 0;
    for (const proposal of input.proposals) {
      const validated = validateProposal(proposal);
      if (!validated) continue;
      if (validated.proposal.action === "remove") {
        removed += await this.removeOne(input.guildId, validated.proposal);
        continue;
      }
      const memory = await this.upsertOne(input, validated.proposal, validated.topic, validated.slot, validated.statement!);
      if (memory) ingested.push(memory);
    }
    return { ingested, removed };
  }

  private async removeOne(guildId: string, proposal: Extract<import("./memory.js").ProposedMemory, { action: "remove" }>): Promise<number> {
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
    proposal: Extract<import("./memory.js").ProposedMemory, { action: "upsert" }>,
    topic: string,
    slot: string,
    statement: string,
  ): Promise<Memory | null> {
    const scope = resolveMemoryScope(input.channelMode, input.channelId, {
      audience: proposal.audience,
      channelScoped: proposal.channelScoped,
    });
    const status = resolveInitialStatus(scope.audience, proposal.subjectType, proposal.subjectId, input.assertedByUserId, input.source);
    const embedding = this.embeddingsClient ? await this.embeddingsClient.embed(statement).catch(() => null) : null;
    try {
      return await this.repository.ingest({
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
        assertedByUserId: input.assertedByUserId,
      });
    } catch (error) {
      this.logger?.warn({ error, guildId: input.guildId }, "Memory ingest failed for one proposal");
      return null;
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
