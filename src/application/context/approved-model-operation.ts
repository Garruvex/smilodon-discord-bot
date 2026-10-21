import { createHash } from "node:crypto";
import type { StructuredCallOptions } from "../chat/chat-provider.js";
import { isGuardedContext, type GuardedConversationContext } from "../chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { isBackgroundContext, type GuardedBackgroundContext } from "./guarded-background-context.js";
import { isConfigurationContext, type GuardedConfigurationContext } from "./guarded-configuration-context.js";
import { isEvaluationContext, type GuardedEvaluationContext } from "./guarded-evaluation-context.js";

export type ModelAuthority = GuardedConversationContext | GuardedBackgroundContext | GuardedConfigurationContext | GuardedEvaluationContext;
export type UtilityOperation = "generateCharacterData" | "summarizeDroppedExchanges" | "summarizeReplyChainOverflow" |
  "extractPersonalMemories" | "evolvePersonaDrift" | "summarizeChannelMessages" | "analyzeUserCustomization" |
  "compilePersonaBundle" | "classifyMemoryConflict" | "generateReferenceImage";
interface Receipt { method: UtilityOperation; hash: string; check: () => Promise<void>; options: StructuredCallOptions; used: boolean }
const receipts = new WeakMap<object, Receipt>();

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
export function consumeModelOperation(method: UtilityOperation, args: readonly unknown[], options: StructuredCallOptions | undefined): StructuredCallOptions {
  const receipt = options && receipts.get(options);
  if (!receipt || receipt.used || receipt.method !== method || receipt.hash !== digest(args)) throw new SocialOutputSuppressed();
  receipt.used = true;
  return { ...receipt.options };
}
