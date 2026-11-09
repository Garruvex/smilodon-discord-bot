import { isGuardedContext } from "../chat/guarded-conversation-context.js";
import type { GuardedConversationContext } from "../chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { immutableSnapshot } from "./immutable-snapshot.js";

const approved = new WeakSet<object>();
// Issued only by the live assembler or explicitly synthetic replay. This
// receipt owns the social projection before the decision serializer sees it.
export function approveDecisionInput<T extends { sourceContext?: GuardedConversationContext }>(input: T): T {
  if (!isGuardedContext(input.sourceContext)) throw new SocialOutputSuppressed();
  const references = new Set(["sourceContext", "canUseContext", "signal"]);
  const copy = Object.freeze(Object.fromEntries(Object.entries(input).map(([key, value]) => [key, references.has(key) ? value : immutableSnapshot(value)]))) as T;
  approved.add(copy); return copy;
}
export function isApprovedDecisionInput(input: object): boolean { return approved.has(input); }
