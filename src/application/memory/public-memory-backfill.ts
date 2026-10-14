import type { MemoryRepository } from "./memory.js";
import { resolveMemoryScope, type ChannelMemoryMode, type ResolvedMemoryScope } from "./memory-channel-policy.js";

export interface ReviewedPublicMemory {
  guildId: string; memoryId: string; sourceMessageId: string; sourceChannelId: string;
  historicalMode: "shared" | "isolated"; sourceQuote: string; approved: true;
}
export interface VerifiedHumanMessage {
  guildId: string; channelId: string; messageId: string; authorId: string; authorIsBot: boolean;
  content: string; timestampMs: number;
}

export type PublicMemoryBackfillPlan = { memoryId: string; eligible: false; reason: string } |
  { memoryId: string; eligible: true; reason: string; scope: ResolvedMemoryScope; command: Parameters<MemoryRepository["reclassifyPublicMemory"]>[0] };

export async function planPublicMemoryBackfill(repository: MemoryRepository, reviewed: ReviewedPublicMemory,
  original: VerifiedHumanMessage | null, currentMode: ChannelMemoryMode): Promise<PublicMemoryBackfillPlan> {
  const skip = (reason: string): Extract<PublicMemoryBackfillPlan, { eligible: false }> => ({ memoryId: reviewed.memoryId, eligible: false, reason });
  const memory = await repository.findById(reviewed.guildId, reviewed.memoryId);
  if (!memory) return skip("memory_missing");
  if (memory.audience !== "private") return skip("already_shared_or_not_private");
  if (memory.status !== "active" && memory.status !== "candidate") return skip("not_current");
  if (memory.subjectType !== "member" || memory.subjectId !== memory.ownerUserId) return skip("not_a_self_fact");
  if (!original || original.authorIsBot || original.authorId !== memory.subjectId || original.guildId !== reviewed.guildId ||
      original.channelId !== reviewed.sourceChannelId || original.messageId !== reviewed.sourceMessageId) return skip("unverified_human_source");
  const quote = reviewed.sourceQuote.trim();
  if (!quote || !original.content.includes(quote)) return skip("quote_not_in_original_message");
  if (currentMode === "disabled" || currentMode === "session_only") return skip("durable_writes_disabled");
  const sources = await repository.findSources(memory.id);
  const source = sources.find((item) => item.sourceMessageId === original.messageId && item.sourceChannelId === original.channelId &&
    item.assertedByUserId === original.authorId);
  if (!source || source.sourceMessageId?.startsWith("batch:")) return skip("stored_provenance_missing");
  if (source.sourceQuote && source.sourceQuote !== quote) return skip("stored_quote_disagrees");
  if (source.sourceChannelMode && source.sourceChannelMode !== reviewed.historicalMode) return skip("historical_scope_disagrees");
  if (memory.isolationChannelId && memory.isolationChannelId !== reviewed.sourceChannelId) return skip("isolation_disagrees");
  const mode = reviewed.historicalMode === "isolated" || currentMode === "isolated" || memory.isolationChannelId ? "isolated" : "shared";
  const scope = resolveMemoryScope(mode, original.channelId, { audience: "private", channelScoped: memory.kind === "episode" }, true);
  if (await repository.isSourceForgotten({ guildId: memory.guildId, subjectId: memory.subjectId, topic: memory.topic, slot: memory.slot,
    channelId: original.channelId, sourceTimestampMs: original.timestampMs })) return skip("source_was_forgotten");
  const existing = await repository.findActiveBySubject({ guildId: memory.guildId, subjectType: memory.subjectType, subjectId: memory.subjectId,
    audience: scope.audience, ownerUserId: null, channelId: scope.channelId, isolationChannelId: scope.isolationChannelId });
  if (existing.some((item) => item.topic === memory.topic && item.slot === memory.slot)) return skip("shared_identity_already_exists_review_required");
  return { memoryId: memory.id, eligible: true as const, reason: "verified_human_source_and_reviewed_scope", scope,
    command: { guildId: memory.guildId, memoryId: memory.id, sourceMessageId: original.messageId, sourceChannelId: original.channelId,
      assertedByUserId: original.authorId, sourceQuote: quote, mode, sourceTimestampMs: original.timestampMs, now: Date.now() } };
}
