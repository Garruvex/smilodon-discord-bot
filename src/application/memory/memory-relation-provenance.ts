import { z } from "zod";
import { hashContent } from "../assets/content-hash.js";
import { parseContextProvenance, type ContextProvenance } from "../chat/context-provenance.js";

const subject = z.enum(["member", "guild", "team", "project", "npc", "faction", "location"]);
const identitySchema = z.object({ guildId: z.string().min(1).max(128), channelId: z.string().min(1).max(128).nullable().optional(),
  fromSubjectType: subject, fromSubjectId: z.string().min(1).max(128), toSubjectType: subject, toSubjectId: z.string().min(1).max(128),
  predicate: z.enum(["member_of", "allied_with", "hostile_to", "owes", "controls", "located_in", "owns"]), kind: z.enum(["association", "consequence"]),
  isolationChannelId: z.string().nullable(), supportingMemoryId: z.string().nullable(),
});
export type RelationIdentity = z.input<typeof identitySchema>;
export function memoryRelationPayload(value: unknown): string | null {
  const result = identitySchema.safeParse(value); if (!result.success) return null;
  const { guildId, channelId, fromSubjectType, fromSubjectId, toSubjectType, toSubjectId, predicate, kind, isolationChannelId, supportingMemoryId } = result.data;
  if (fromSubjectType === toSubjectType && fromSubjectId === toSubjectId) return null;
  if (channelId && (fromSubjectType === "guild" && fromSubjectId !== guildId || toSubjectType === "guild" && toSubjectId !== guildId)) return null;
  return JSON.stringify({ guildId, channelId: channelId ?? null, fromSubjectType, fromSubjectId, predicate, kind, toSubjectType, toSubjectId, isolationChannelId, supportingMemoryId });
}
export function memoryRelationProof(value: unknown, relation: unknown): ContextProvenance | null {
  const payload = memoryRelationPayload(relation); const proof = parseContextProvenance(value);
  return payload && proof?.purpose === "relation" && proof.coverage === "complete" && proof.outputHash === hashContent(payload) ? proof : null;
}
