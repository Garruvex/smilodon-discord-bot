import { z } from "zod";
import { hashContent } from "../assets/content-hash.js";
import type { ChatRequest } from "./chat-provider.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const contextProvenanceLimits = { dependencies: 128, serializedChars: 48_000 } as const;
export const contextProvenanceSchema = z.object({
  version: z.literal(1),
  coverage: z.enum(["partial", "complete"]),
  audience: z.object({ guildId: id, channelId: id, userId: id.nullable() }).strict(),
  outputHash: digest,
  dependencies: z.array(z.object({
    guildId: id, channelId: id, messageId: id, authorId: id,
    timestampMs: z.number().finite().nonnegative(),
    // Hash of the representation supplied to this turn, not a claim to have
    // captured every field or the full original Discord message.
    representationHash: digest,
  }).strict()).max(contextProvenanceLimits.dependencies),
  unresolved: z.array(z.enum(["unguarded_prompt_sources", "missing_current_event", "missing_source_scope", "conflicting_source", "dependency_cap"])).max(5),
}).strict().superRefine((value, context) => {
  if (value.coverage === "complete" && (value.unresolved.length > 0 || value.dependencies.length === 0))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Complete provenance requires a closed dependency set" });
  const keys = value.dependencies.map((source) => `${source.guildId}:${source.channelId}:${source.messageId}`);
  if (new Set(keys).size !== keys.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate dependencies" });
});
export type ContextProvenance = z.infer<typeof contextProvenanceSchema>;

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
