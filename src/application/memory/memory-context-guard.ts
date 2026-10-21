import { isGuardedContext } from "../chat/guarded-conversation-context.js";
import { isBackgroundContext } from "../context/guarded-background-context.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import type { MemoryIngestInput, Memory } from "./memory.js";
import type { EmbeddingCallOptions } from "../chat/embeddings-client.js";
import { hashContent } from "../assets/content-hash.js";
import type { AliasScope } from "./memory-alias-provenance.js";
import type { ObservedSubjectName } from "./observed-subject-names.js";
import { approveModelOperation } from "../context/approved-model-operation.js";

export async function checkMemoryContext(context: MemoryIngestInput["context"]): Promise<void> {
  if (context === undefined) return; // Explicit legacy compatibility; never issues a complete claim proof.
  if (isGuardedContext(context)) { if (!await context.validate()) throw new SocialOutputSuppressed(); return; }
  if (isBackgroundContext(context, "summary") || isBackgroundContext(context, "memory_extraction")) { await context.check(); return; }
  throw new SocialOutputSuppressed();
}

export function memoryModelOptions(context: MemoryIngestInput["context"], purpose: "recall_embedding" | "claim_embedding" | "conflict_classification", payload: readonly unknown[] = []): EmbeddingCallOptions {
  if (context === undefined) return {};
  if (!isGuardedContext(context) && !isBackgroundContext(context, "summary") && !isBackgroundContext(context, "memory_extraction")) throw new SocialOutputSuppressed();
  const proof = context.provenance(`operation:${purpose}`, "memory_claim");
  if (!proof) throw new SocialOutputSuppressed();
  const options = { beforeAttempt: (): Promise<void> => checkMemoryContext(context), cacheScope: `${purpose}:${hashContent(JSON.stringify(proof))}`,
    ...(isGuardedContext(context) && context.cancellationSignal ? { signal: context.cancellationSignal } : {}) };
  return purpose === "conflict_classification" ? approveModelOperation(context, "classifyMemoryConflict", payload, options) : options;
}

export async function authorizeClassificationClaims(context: MemoryIngestInput["context"], records: readonly Memory[], now: number): Promise<readonly Memory[]> {
  if (context === undefined) return records;
  if (!isGuardedContext(context) && !isBackgroundContext(context, "summary") && !isBackgroundContext(context, "memory_extraction")) throw new SocialOutputSuppressed();
  return context.classificationClaims(records, now);
}

export async function authorizeRelationMembers(context: MemoryIngestInput["context"], ids: readonly string[]): Promise<ReadonlySet<string>> {
  if (context === undefined) return new Set(ids);
  if (isGuardedContext(context)) return new Set((await context.participants(ids)).map((actor) => actor.id));
  if (isBackgroundContext(context, "summary") || isBackgroundContext(context, "memory_extraction")) {
    await context.check(); return new Set(context.messages.map((message) => message.authorId));
  }
  throw new SocialOutputSuppressed();
}

export async function observedNamesForContext(context: MemoryIngestInput["context"], scope: AliasScope, names: readonly string[], now: number): Promise<ObservedSubjectName[]> {
  if (context === undefined) return names.filter((name) => name.trim()).map((name) => ({ value: name.slice(0, 100), observedAt: now }));
  if (!isGuardedContext(context) && !isBackgroundContext(context, "summary") && !isBackgroundContext(context, "memory_extraction")) throw new SocialOutputSuppressed();
  return context.observeAliases(scope, names, now);
}
