import { z } from "zod";
import { hashContent } from "../assets/content-hash.js";
import { canRecall, type Memory, type MemoryRepository, type RepositoryIngestInput } from "../memory/memory.js";
import { memoryClaimPayload, memoryClaimProof } from "../memory/memory-claim-provenance.js";
import { parseContextProvenance } from "../chat/context-provenance.js";
import { isConfigurationContext, type GuardedConfigurationContext } from "./guarded-configuration-context.js";

const authored = z.object({ version: z.literal(1), editorId: z.string().min(1).max(128), editedAt: z.number().finite().nonnegative() }).strict();
const metadata = z.object({ personaHash: z.string().max(128).optional(), dependencies: z.array(z.object({ id: z.string(), updatedAt: z.number(), subjectId: z.string(), sourceIds: z.array(z.string()).default([]) })).max(128).default([]) }).passthrough();
const modules = new Set(["canon", "mood", "daily-sketch"]);
function resourceId(memory: Memory): string {
  return `${memory.moduleId}:${hashContent(JSON.stringify([memory.kind, memory.audience, memory.ownerUserId, memory.channelId,
    memory.isolationChannelId, memory.subjectType, memory.subjectId, memory.topic, memory.slot]))}`;
}

// The settings action already authorizes this explicit authored replacement.
// Preserve verified parent restrictions; do not promote any legacy learned
// text/metadata merely because its source field says administrator.
export function authorCharacterEdit(memory: Memory, channelId: string, editorId: string, statement: string, now: number, persona: GuardedConfigurationContext): RepositoryIngestInput | null {
  if (!isConfigurationContext(persona, "persona") || persona.scope.guildId !== memory.guildId ||
      !memory.moduleId || !modules.has(memory.moduleId) || memory.subjectType !== "persona" || memory.subjectId !== "character" ||
      memory.audience === "private" || !statement.trim() || statement.length > 200 || !authored.safeParse({ version: 1, editorId, editedAt: now }).success) return null;
  const previous = memoryClaimProof(memory.contextProvenance, memory);
  const destination = channelId || previous?.audience.channelId || memory.isolationChannelId || memory.channelId;
  if (!destination || previous && previous.audience.channelId !== destination || !canRecall(memory, { guildId: memory.guildId, channelId: destination, userId: editorId }, now)) return null;
  const old = metadata.safeParse(memory.structuredValue); const parent = previous && old.success ? old.data : null;
  const claim = { ...memory, statement: statement.trim(), source: "administrator" as const, sourceMessageId: null, sourceChannelId: null,
    assertedByUserId: editorId, now, embedding: null, embeddingModel: null,
    structuredValue: { personaHash: persona.material.personalitySourceHash ?? hashContent(persona.material.text),
      dependencies: parent?.dependencies ?? [], authoredConfiguration: { version: 1, editorId, editedAt: now } } };
  const fingerprint = hashContent(memoryClaimPayload(claim));
  const key = resourceId(memory);
  const contextProvenance = parseContextProvenance({ ...(previous ?? {}), version: 1, purpose: "memory_claim", coverage: "complete",
    audience: { guildId: memory.guildId, channelId: destination, userId: null }, outputHash: fingerprint, dependencies: previous?.dependencies ?? [], unresolved: [],
    resources: [...(previous?.resources ?? []).filter((resource) => !(resource.kind === "character_configuration" && resource.id === key) && resource.kind !== "persona_configuration"),
      { kind: "persona_configuration", id: "current", representationHash: hashContent(persona.fingerprint) },
      { kind: "character_configuration", id: key, representationHash: hashContent(fingerprint) }] });
  return contextProvenance ? { ...claim, contextProvenance } : null;
}

// Revalidate the persisted authored revision, lifecycle and exact destination.
// The resource is a fingerprint, never unfiltered model-visible record text.
export async function authoredCharacterResource(repository: Pick<MemoryRepository, "findModuleCandidates" | "findSources">, guildId: string, channelId: string, id: string, now: number): Promise<string | null> {
  const [moduleId, identity, ...extra] = id.split(":");
  if (!moduleId || !modules.has(moduleId) || !identity || !/^[a-f0-9]{64}$/u.test(identity) || extra.length) return null;
  const candidates = await repository.findModuleCandidates?.({ guildId, channelId, userId: "configuration", moduleId, now });
  const row = candidates?.memories.find((memory) => resourceId(memory) === id);
  if (!row || row.guildId !== guildId || !row.moduleId || !modules.has(row.moduleId) ||
      row.subjectType !== "persona" || row.subjectId !== "character" || row.audience === "private" ||
      !canRecall(row, { guildId, channelId, userId: "configuration" }, now) || !metadata.safeParse(row.structuredValue).success) return null;
  const revision = authored.safeParse((row.structuredValue as { authoredConfiguration?: unknown }).authoredConfiguration);
  const proof = memoryClaimProof(row.contextProvenance, row); const fingerprint = hashContent(memoryClaimPayload(row));
  if (!revision.success || revision.data.editedAt !== row.updatedAt ||
      !proof || proof.audience.channelId !== channelId || !proof.resources?.some((resource) => resource.kind === "character_configuration" && resource.id === id && resource.representationHash === hashContent(fingerprint))) return null;
  const sources = await repository.findSources(row.id);
  if (!sources.some((source) => source.source === "administrator" && source.createdAt === revision.data.editedAt && source.assertedByUserId === revision.data.editorId && source.statement === row.statement)) return null;
  return fingerprint;
}
