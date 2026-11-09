import { createHash } from "node:crypto";
import type { StructuredCallOptions } from "../chat/chat-provider.js";
import { isGuardedContext, type GuardedConversationContext } from "../chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { isBackgroundContext, type GuardedBackgroundContext } from "./guarded-background-context.js";
import { isConfigurationContext, type GuardedConfigurationContext } from "./guarded-configuration-context.js";
import { isEvaluationContext, type GuardedEvaluationContext } from "./guarded-evaluation-context.js";
import type { EmbeddingCallOptions } from "../chat/embeddings-client.js";

export type ModelAuthority = GuardedConversationContext | GuardedBackgroundContext | GuardedConfigurationContext | GuardedEvaluationContext;
export type UtilityOperation = "generateCharacterData" | "summarizeDroppedExchanges" | "summarizeReplyChainOverflow" |
  "extractPersonalMemories" | "evolvePersonaDrift" | "summarizeChannelMessages" | "analyzeUserCustomization" |
  "compilePersonaBundle" | "classifyMemoryConflict" | "generateReferenceImage" | "verifyAttribution";
interface Receipt { method: UtilityOperation; hash: string; check: () => Promise<void>; options: StructuredCallOptions; used: boolean }
const receipts = new WeakMap<object, Receipt>();
interface EmbeddingReceipt { remaining: Map<string, number>; fallback: Map<string, number>; options: EmbeddingCallOptions }
const embeddingReceipts = new WeakMap<object, EmbeddingReceipt>();

// Copy before the first await, including binary image data. The transport owns
// this copy; subsequent mutation of the caller's values cannot change dispatch.
export function snapshotModelArguments(args: readonly unknown[]): unknown[] {
  const copy = (value: unknown): unknown => {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (Array.isArray(value)) return value.map(copy);
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    throw new SocialOutputSuppressed();
  };
  return args.map(copy);
}
function digest(args: readonly unknown[]): string {
  const canonical = (value: unknown): unknown => {
    if (Buffer.isBuffer(value)) return { binary: value.toString("base64") };
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex");
}
function authorityCheck(authority: ModelAuthority): () => Promise<void> {
  if (isGuardedContext(authority)) return async (): Promise<void> => { if (!await authority.validate()) throw new SocialOutputSuppressed(); };
  if (isBackgroundContext(authority, "summary") || isBackgroundContext(authority, "memory_extraction") || isConfigurationContext(authority) || isEvaluationContext(authority)) return (): Promise<void> => authority.check();
  throw new SocialOutputSuppressed();
}
function issue(method: UtilityOperation, args: readonly unknown[], check: () => Promise<void>, options: StructuredCallOptions): StructuredCallOptions {
  const original = { ...options };
  const pinned = Object.freeze({ ...original, beforeAttempt: async (): Promise<void> => {
    original.signal?.throwIfAborted(); await check(); await original.beforeAttempt?.(); original.signal?.throwIfAborted();
  } });
  const receipt = Object.freeze({ ...pinned });
  receipts.set(receipt, { method, hash: digest(snapshotModelArguments(args)), check, options: pinned, used: false });
  return receipt;
}
// Only reviewed serializers may import issuance. A valid lease alone does not
// authorize arbitrary content; the serializer owns the admitted projection.
export function approveModelOperation(authority: ModelAuthority, method: UtilityOperation, args: readonly unknown[], options: StructuredCallOptions = {}): StructuredCallOptions {
  return issue(method, args, authorityCheck(authority), options);
}
// The decision owner's fixed, synthetic health fixture is the sole issuer.
// This operation has no participant/configuration authority or reusable lease.
export function approveDiagnosticModelOperation(prompt: string, schema: Record<string, unknown>, options: StructuredCallOptions): StructuredCallOptions {
  return issue("generateCharacterData", [prompt, schema], async (): Promise<void> => {}, options);
}
export function consumeModelOperation(method: UtilityOperation, args: readonly unknown[], options: StructuredCallOptions | (() => Promise<void>) | undefined): StructuredCallOptions {
  const receipt = options && receipts.get(options);
  if (!receipt || receipt.used || receipt.method !== method || receipt.hash !== digest(args)) throw new SocialOutputSuppressed();
  receipt.used = true;
  return { ...receipt.options };
}

export function approveAttributionOperation(authority: ModelAuthority, args: readonly unknown[], beforeAttempt: () => Promise<void>): () => Promise<void> {
  const options = approveModelOperation(authority, "verifyAttribution", args, { beforeAttempt });
  const check = options.beforeAttempt!; receipts.set(check, receipts.get(options)!); return check;
}

export function approveEmbeddingOperation(authority: ModelAuthority, texts: readonly string[], options: EmbeddingCallOptions = {}): EmbeddingCallOptions {
  if (texts.length > 512 || texts.some((text) => typeof text !== "string")) throw new SocialOutputSuppressed();
  const check = authorityCheck(authority); const original = { ...options };
  const pinned = Object.freeze({ ...original, beforeAttempt: async (): Promise<void> => {
    original.signal?.throwIfAborted(); await check(); await original.beforeAttempt?.(); original.signal?.throwIfAborted();
  } });
  const remaining = new Map<string, number>();
  for (const text of texts) { const key = digest([text]); remaining.set(key, (remaining.get(key) ?? 0) + 1); }
  embeddingReceipts.set(pinned, { remaining, fallback: new Map(), options: pinned }); return pinned;
}

// A batch spends each admitted text once. Only a failed batch grants one
// individual fallback per member; successful calls cannot replay the receipt.
export function consumeEmbeddingOperation(batch: boolean, texts: readonly string[], options?: EmbeddingCallOptions): {
  options: EmbeddingCallOptions; failed: () => void;
} {
  const receipt = options && embeddingReceipts.get(options);
  if (!receipt || !texts.length || batch && texts.length > 32 || !batch && texts.length !== 1) throw new SocialOutputSuppressed();
  const remaining = new Map(receipt.remaining); const fallback = new Map(receipt.fallback);
  const keys = texts.map((text) => digest([text]));
  for (const key of keys) {
    const pool = (remaining.get(key) ?? 0) > 0 ? remaining : !batch ? fallback : null;
    if (!pool || (pool.get(key) ?? 0) <= 0) throw new SocialOutputSuppressed();
    pool.set(key, pool.get(key)! - 1);
  }
  receipt.remaining = remaining; receipt.fallback = fallback;
  let released = false;
  return { options: { ...receipt.options }, failed: (): void => {
    if (!batch || released) return; released = true;
    for (const key of keys) receipt.fallback.set(key, (receipt.fallback.get(key) ?? 0) + 1);
  } };
}
