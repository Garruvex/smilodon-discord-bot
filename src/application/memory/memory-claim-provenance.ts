import { hashContent } from "../assets/content-hash.js";
import { parseContextProvenance, type ContextProvenance } from "../chat/context-provenance.js";
import type { Memory } from "./memory.js";

export type MemoryClaimIdentity = Pick<Memory, "guildId" | "kind" | "audience" | "ownerUserId" | "channelId" | "isolationChannelId" | "subjectType" | "subjectId" | "topic" | "slot" | "statement"> & { moduleId?: string | null; structuredValue?: unknown };
type StoredClaim = Omit<MemoryClaimIdentity, "kind" | "audience" | "subjectType"> & { kind: string; audience: string; subjectType: string };
export function memoryClaimPayload(claim: StoredClaim): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return JSON.stringify({ guildId: claim.guildId, moduleId: claim.moduleId ?? null, kind: claim.kind, audience: claim.audience,
    ownerUserId: claim.ownerUserId, channelId: claim.channelId, isolationChannelId: claim.isolationChannelId,
    subjectType: claim.subjectType, subjectId: claim.subjectId, topic: claim.topic, slot: claim.slot, statement: claim.statement,
    ...(claim.moduleId ? { structuredValue: canonical(claim.structuredValue ?? null) } : {}) });
}
export function memoryClaimProof(value: unknown, claim: StoredClaim): ContextProvenance | null {
  const proof = parseContextProvenance(value);
  return proof?.purpose === "memory_claim" && proof.coverage === "complete" && proof.audience.guildId === claim.guildId &&
    proof.outputHash === hashContent(memoryClaimPayload(claim)) ? proof : null;
}
