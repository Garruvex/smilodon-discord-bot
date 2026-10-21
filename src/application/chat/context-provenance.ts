import { z } from "zod";
import { hashContent } from "../assets/content-hash.js";
import type { ChatRequest, ChannelHistoryMessage, ChatUser } from "./chat-provider.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const contextProvenanceLimits = { dependencies: 128, serializedChars: 48_000 } as const;
export const contextProvenanceSchema = z.object({
  version: z.literal(1),
  purpose: z.enum(["reply", "memory_claim", "character_state", "relation", "identity_alias"]).optional(),
  coverage: z.enum(["partial", "complete"]),
  audience: z.object({ guildId: id, channelId: id, userId: id.nullable() }).strict(),
  outputHash: digest,
  outputAssetsHash: digest.optional(),
  dependencies: z.array(z.object({
    guildId: id, channelId: id, messageId: id, authorId: id,
    timestampMs: z.number().finite().nonnegative(),
    // Hash of the representation supplied to this turn, not a claim to have
    // captured every field or the full original Discord message.
    representationHash: digest,
    assetsHash: digest.optional(),
    projection: z.object({ kind: z.enum(["background_text", "human_text"]), chars: z.number().int().positive().max(16000) }).strict().optional(),
  }).strict()).max(contextProvenanceLimits.dependencies),
  actors: z.array(z.object({ userId: id, representationHash: digest, projection: z.literal("identity").optional() }).strict()).max(100).optional(),
  // Public provider-managed search is separate from protected Discord inputs.
  // This records use and citation identity, not factual truth or a fresh crawl.
  publicWeb: z.object({ citationHashes: z.array(digest).max(128) }).strict().optional(),
  publicTools: z.array(z.object({ name: z.string().regex(/^[a-z_]{1,64}$/), outputHash: digest }).strict()).max(128).optional(),
  resources: z.array(z.object({ kind: z.enum(["birthday", "server_metadata", "server_events", "self_reference_image", "music_queue", "persona_configuration", "user_preferences", "persona_drift"]), id,
    representationHash: digest }).strict()).max(32).optional(),
  unresolved: z.array(z.enum(["unguarded_prompt_sources", "missing_current_event", "missing_source_scope", "conflicting_source", "dependency_cap"])).max(5),
}).strict().superRefine((value, context) => {
  if (value.coverage === "complete" && (value.unresolved.length > 0 || value.dependencies.length === 0))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Complete provenance requires a closed dependency set" });
  const keys = value.dependencies.map((source) => `${source.guildId}:${source.channelId}:${source.messageId}`);
  if (new Set(keys).size !== keys.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate dependencies" });
  if (new Set(value.actors?.map((actor) => actor.userId)).size !== (value.actors?.length ?? 0) ||
      new Set(value.resources?.map((resource) => `${resource.kind}:${resource.id}`)).size !== (value.resources?.length ?? 0))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate actor or resource dependencies" });
});
export type ContextProvenance = z.infer<typeof contextProvenanceSchema>;

export function backgroundSourceHash(source: { authorId: string; authorDisplayName: string; content: string; timestampMs: number }): string {
  return hashContent(JSON.stringify(source));
}
export function humanTextSourceHash(source: { authorId: string; content: string; timestampMs: number }): string {
  return hashContent(JSON.stringify(source));
}
export function actorSourceHash(actor: ChatUser, projection?: "identity"): string {
  return hashContent(JSON.stringify(projection === "identity" ? { id: actor.id } : actor));
}

export function dependencyMatchesSource(dependency: ContextProvenance["dependencies"][number], source: ChannelHistoryMessage, conversationHash: string): boolean {
  return dependency.authorId === source.authorId && dependency.timestampMs === source.timestampMs && dependency.representationHash ===
    (dependency.projection?.kind === "human_text" ? humanTextSourceHash({ authorId: source.authorId, content: source.content.trim().slice(0, dependency.projection.chars), timestampMs: source.timestampMs }) :
      dependency.projection ? backgroundSourceHash({ authorId: source.authorId, authorDisplayName: source.authorDisplayName,
      content: source.content.trim().slice(0, dependency.projection.chars), timestampMs: source.timestampMs }) : conversationHash);
}

// Invalid/legacy provenance cannot break loading other records or become a
// reusable proof. No raw prompt text belongs in this persisted metadata.
export function parseContextProvenance(value: unknown): ContextProvenance | null {
  try {
    if (JSON.stringify(value)?.length > contextProvenanceLimits.serializedChars) return null;
    const result = contextProvenanceSchema.safeParse(value);
    return result.success ? result.data : null;
  } catch { return null; }
}

export function parseScopedContextProvenance(value: unknown, destination: { guildId: string; channelId: string; userId?: string }): ContextProvenance | null {
  const provenance = parseContextProvenance(value);
  if (!provenance || provenance.audience.guildId !== destination.guildId || provenance.audience.channelId !== destination.channelId ||
    destination.userId !== undefined && provenance.audience.userId !== null && provenance.audience.userId !== destination.userId) return null;
  return provenance;
}

export function bindProvenanceOutput(value: unknown, output: string, destination: { guildId: string; channelId: string; userId?: string }): ContextProvenance | null {
  const provenance = parseScopedContextProvenance(value, destination);
  if (!provenance) return null;
  const outputHash = hashContent(output);
  // Rebinding an incomplete capture to the actual delivered representation
  // does not issue authority to rewrite a future complete proof.
  if (provenance.coverage === "complete" && provenance.outputHash !== outputHash) return null;
  return { ...provenance, outputHash };
}

// The current assembly still contains independently supplied session, memory,
// character and tool context. Record known dependencies, but NEVER certify
// closure merely because the raw history has been filtered. Only a future
// guarded assembly covering every input may issue complete provenance.
export function captureIncompleteTurnProvenance(request: ChatRequest, output: string): ContextProvenance | null {
  const dependencies = new Map<string, ContextProvenance["dependencies"][number]>();
  const unresolved = new Set<ContextProvenance["unresolved"][number]>(["unguarded_prompt_sources"]);
  const add = (source: ContextProvenance["dependencies"][number]): void => {
    const key = `${source.guildId}:${source.channelId}:${source.messageId}`;
    const prior = dependencies.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(source)) unresolved.add("conflicting_source");
    if (!prior && dependencies.size >= contextProvenanceLimits.dependencies) { unresolved.add("dependency_cap"); return; }
    if (!prior) dependencies.set(key, source);
  };
  for (const message of [...request.replyChain, ...request.channelHistory, ...(request.currentBurst ?? [])]) {
    if (!message.channelId) { unresolved.add("missing_source_scope"); continue; }
    add({ guildId: request.guildId, channelId: message.channelId, messageId: message.messageId, authorId: message.authorId,
      timestampMs: message.timestampMs, representationHash: hashContent(message.content) });
  }
  if (request.currentEvent?.type === "message") add({ guildId: request.guildId, channelId: request.currentEvent.channelId,
    messageId: request.currentEvent.messageId, authorId: request.currentEvent.authorId,
    timestampMs: request.currentEvent.timestampMs, representationHash: hashContent(request.message) });
  else unresolved.add("missing_current_event");
  return parseContextProvenance({ version: 1, coverage: "partial",
    audience: { guildId: request.guildId, channelId: request.channelId, userId: request.currentUser.id },
    outputHash: hashContent(output), dependencies: [...dependencies.values()], unresolved: [...unresolved] });
}
