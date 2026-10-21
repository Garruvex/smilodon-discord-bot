import { fadingWeight } from "../memory/fading.js";
import { z } from "zod";
import type { GuildConfiguration } from "../../config/guild-configuration.js";
import { canRecall, type CandidateQuery, type Memory, type MemoryRepository, type RepositoryIngestInput } from "../memory/memory.js";
import { allowsDurableWrites, resolveChannelMemoryMode } from "../memory/memory-channel-policy.js";
import { characterSettings } from "./character-settings.js";
import type { CharacterModuleId } from "./character-settings.js";
import type { PersonalMemoryExtractionQueueStore } from "../context/personal-memory-extraction-queue.js";
import { isGuardedContext, type GuardedConversationContext } from "./guarded-conversation-context.js";
import { memoryClaimPayload } from "../memory/memory-claim-provenance.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";

export type CharacterCandidateQuery = CandidateQuery & { sourceContext?: GuardedConversationContext };
export type CharacterMemoryWrite = Omit<RepositoryIngestInput, "guildId" | "moduleId"> & { sourceContext?: GuardedConversationContext };

const dependencySchema = z.object({ id: z.string(), updatedAt: z.number(), subjectId: z.string(), sourceIds: z.array(z.string()).default([]) });
const metadataSchema = z.object({ dependencies: z.array(dependencySchema).default([]), personaHash: z.string().optional() }).passthrough();
export function memoryScopeKey(memory: Pick<Memory, "audience" | "ownerUserId" | "channelId" | "isolationChannelId">): string {
  return JSON.stringify([memory.audience, memory.ownerUserId, memory.channelId, memory.isolationChannelId]);
}
export function partitionMemorySources(memories: readonly Memory[]): readonly Memory[][] {
  const groups = new Map<string, Memory[]>();
  for (const memory of memories) { const key = memoryScopeKey(memory); groups.set(key, [...(groups.get(key) ?? []), memory]); }
  return [...groups.values()];
}

// Dedicated application-only module writes. Model memory proposals never
// receive this capability; bot assertions still cannot create member facts.
export class CharacterMemory {
  public constructor(private readonly repository: MemoryRepository,
    private readonly coordinator: Pick<PersonalMemoryExtractionQueueStore, "runForSubject"> | null = null,
    private readonly resolveProfile: ((guildId: string) => GuildConfiguration | null) | null = null,
    private readonly canWrite: ((guildId: string, channelId: string, moduleId: CharacterModuleId) => boolean) | null = null) {}
  public async sourceEligible(memory: Memory, profile: GuildConfiguration, query: CharacterCandidateQuery): Promise<boolean> {
    if (query.sourceContext) {
      if (!isGuardedContext(query.sourceContext)) throw new SocialOutputSuppressed();
      const admitted = memory.moduleId ? await query.sourceContext.characterMemories([memory], true, query.now) : await query.sourceContext.memories([memory], true, query.now);
      if (!admitted.length) return false;
    }
    if (this.resolveProfile) { const current = this.resolveProfile(profile.guildId); if (!current) return false; profile = current; }
    if (!canRecall(memory, query, query.now)) return false;
    const sources = await this.repository.findSources(memory.id);
    for (const source of sources) {
      if (!source.sourceChannelId) continue;
      const mode = resolveChannelMemoryMode(profile.chat.channelMemoryModes, source.sourceChannelId);
      if (!allowsDurableWrites(mode)) return false;
      if (mode === "isolated" && (query.channelId !== source.sourceChannelId || memory.isolationChannelId !== source.sourceChannelId)) return false;
    }
    return true;
  }
  public async read(profile: GuildConfiguration, query: CharacterCandidateQuery, moduleId: CharacterModuleId, personaHash?: string, message = ""): Promise<readonly Memory[]> {
    if (moduleId === "relationships") await this.repository.migrateRelationshipExpiries?.(query.guildId);
    const rows = await this.repository.findModuleCandidates?.({ ...query, moduleId });
    const valid: Memory[] = [];
    for (const memory of rows?.memories ?? []) {
      if (!await this.sourceEligible(memory, profile, query)) continue;
      const parsed = metadataSchema.safeParse(memory.structuredValue ?? {});
      if (!parsed.success || (personaHash && parsed.data.personaHash !== personaHash)) continue;
      if (moduleId === "relationships" && (memory.kind !== "impression" || parsed.data.dependencies.length === 0)) continue;
      let eligible = true;
      const evidenceTimes: number[] = [];
      let sharedHistory = parsed.data.dependencies.length === 1;
      for (const dependency of parsed.data.dependencies) {
        const source = await this.repository.findById(query.guildId, dependency.id);
        if (!source || source.subjectId !== dependency.subjectId || moduleId === "relationships" && source.subjectId !== memory.subjectId ||
            source.updatedAt !== dependency.updatedAt || memoryScopeKey(source) !== memoryScopeKey(memory) ||
            !await this.sourceEligible(source, profile, query)) { eligible = false; break; }
        const evidence = await this.repository.findSources(source.id);
        const sourceIds = new Set(evidence.map((item) => item.id));
        if (moduleId === "relationships") {
          if (source.moduleId) { eligible = false; break; }
          const humanTimes = evidence.filter((item) => dependency.sourceIds.includes(item.id) && item.assertedByUserId !== null && (item.source !== "consolidation" || item.sourceTimestampMs != null))
            .map((item) => item.sourceTimestampMs ?? item.createdAt).filter((time) => Number.isFinite(time) && time <= query.now);
          if (!humanTimes.length) { eligible = false; break; }
          evidenceTimes.push(Math.max(...humanTimes));
          sharedHistory = sharedHistory && source.kind === "episode";
        }
        if (moduleId === "relationships" && (!dependency.sourceIds.length || dependency.sourceIds.some((id) => !sourceIds.has(id)))) { eligible = false; break; }
      }
      if (eligible) valid.push(moduleId === "relationships" ? { ...memory, structuredValue: { ...parsed.data,
        relationshipEvidence: { supportedAt: Math.min(...evidenceTimes), type: sharedHistory ? "historical-event" : "transient" },
      } } : memory);
    }
    const words = new Set([...new Intl.Segmenter("zh", { granularity: "word" }).segment(message.toLowerCase())].filter((part) => part.isWordLike).map((part) => part.segment));
    const settings = characterSettings(profile);
    const fading = settings.enabled && settings.modules.fading.enabled && settings.channelOverrides[query.channelId]?.enabled !== false && settings.channelOverrides[query.channelId]?.modules.fading !== false;
    const score = (memory: Memory): number => {
      const relevance = 1 + [...words].filter((word) => memory.statement.toLowerCase().includes(word)).length;
      if (moduleId !== "relationships" || !fading) return relevance;
      const evidence = (memory.structuredValue as { relationshipEvidence: { supportedAt: number; type: string } }).relationshipEvidence;
      return relevance * (evidence.type === "historical-event" ? 1 : fadingWeight(query.now, evidence.supportedAt, settings.modules.fading.halfLifeDays));
    };
    return valid.sort((left, right) => score(right) - score(left) || (moduleId === "relationships" ? left.id.localeCompare(right.id) : right.updatedAt - left.updatedAt));
  }
  public async write(profile: GuildConfiguration, channelId: string, moduleId: CharacterModuleId, input: CharacterMemoryWrite, dependencies: readonly Memory[] = []): Promise<Memory | null> {
    const write = (): Promise<Memory | null> => this.writeChecked(profile, channelId, moduleId, input, dependencies);
    return this.coordinator ? this.coordinator.runForSubject(profile.guildId, input.subjectId, write) : write();
  }
  private async writeChecked(profile: GuildConfiguration, channelId: string, moduleId: CharacterModuleId, input: CharacterMemoryWrite, dependencies: readonly Memory[]): Promise<Memory | null> {
    const { sourceContext, ...record } = input;
    if (sourceContext && (!isGuardedContext(sourceContext) || !await sourceContext.validate())) throw new SocialOutputSuppressed();
    input = { ...input, topic: `character.${moduleId}` };
    if (this.resolveProfile) { const current = this.resolveProfile(profile.guildId); if (!current) return null; profile = current; }
    if (this.canWrite && !this.canWrite(profile.guildId, channelId, moduleId)) return null;
    const scopeFingerprint = JSON.stringify(profile.chat.channelMemoryModes);
    if (!allowsDurableWrites(resolveChannelMemoryMode(profile.chat.channelMemoryModes, channelId))) return null;
    if (moduleId === "canon" && input.subjectType !== "persona") throw new Error("Canon can only describe the character");
    if (moduleId !== "relationships" && input.subjectType === "member") throw new Error("Only relationship impressions may describe members");
    if (input.subjectType === "member" && (input.kind !== "impression" || !dependencies.length)) throw new Error("Relationship impressions require source-backed dependencies");
    if (input.subjectType === "member" && dependencies.some((source) => source.subjectType !== "member" || source.subjectId !== input.subjectId)) throw new Error("Relationship evidence must describe the same member");
    const query = { guildId: profile.guildId, channelId, userId: input.subjectId, now: input.now, ...(sourceContext ? { sourceContext } : {}) };
    for (const source of dependencies) {
      const current = await this.repository.findById(profile.guildId, source.id);
      if (!current || current.updatedAt !== source.updatedAt || current.status !== "active") return null;
      if (memoryScopeKey(source) !== memoryScopeKey(input) || !await this.sourceEligible(source, profile, query) ||
          await this.repository.isSourceForgotten({ guildId: profile.guildId, subjectId: source.subjectId,
            topic: input.topic, slot: input.slot, channelId, sourceTimestampMs: source.updatedAt })) return null;
    }
    if (await this.repository.isSourceForgotten({ guildId: profile.guildId, subjectId: input.subjectId,
      topic: input.topic, slot: input.slot, channelId, sourceTimestampMs: dependencies[0]?.updatedAt ?? input.now })) return null;
    const metadata = input.structuredValue && typeof input.structuredValue === "object" ? input.structuredValue : {};
    const sourceLists = await Promise.all(dependencies.map((source) => this.repository.findSources(source.id))); const sources = sourceLists.flat();
    if (moduleId === "relationships" && (dependencies.some((source) => source.moduleId) || sourceLists.some((evidence) => !evidence.some((item) => item.assertedByUserId !== null && (item.source !== "consolidation" || item.sourceTimestampMs != null))))) return null;
    if (this.canWrite && !this.canWrite(profile.guildId, channelId, moduleId) || this.resolveProfile && JSON.stringify(this.resolveProfile(profile.guildId)?.chat.channelMemoryModes) !== scopeFingerprint) return null;
    const structuredValue = { ...metadata, dependencies: dependencies.map((source, index) => ({ id: source.id, updatedAt: source.updatedAt, subjectId: source.subjectId, sourceIds: sourceLists[index]!.map((evidence) => evidence.id) })),
        supportingSubjects: [...new Set([...dependencies.map((source) => source.subjectId), ...sources.flatMap((evidence) => evidence.assertedByUserId ? [evidence.assertedByUserId] : [])])],
        supportingSourceMessageIds: [...new Set(sources.flatMap((source) => source.sourceMessageId ? [source.sourceMessageId] : []))] };
    if (sourceContext && !await sourceContext.validate()) throw new SocialOutputSuppressed();
    const claim = { ...record, topic: `character.${moduleId}`, guildId: profile.guildId, moduleId, structuredValue };
    const contextProvenance = sourceContext?.provenance(memoryClaimPayload(claim), "memory_claim") ?? null;
    if (sourceContext && !contextProvenance) throw new SocialOutputSuppressed();
    return this.repository.ingest({ ...claim, assertedByUserId: null, contextProvenance });
  }
}
