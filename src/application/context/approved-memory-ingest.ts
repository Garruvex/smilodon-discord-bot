import type { MemoryIngestInput, MemoryRelationIngestInput } from "../memory/memory.js";
import { isGuardedContext } from "../chat/guarded-conversation-context.js";
import { isBackgroundContext } from "./guarded-background-context.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { immutableSnapshot } from "./immutable-snapshot.js";

const batches = new WeakSet<object>();
const relations = new WeakSet<object>();

// Reviewed live/post-turn/background producers own proposal construction.
// A valid source lease alone cannot authorize arbitrary appended statements,
// source identities, privilege modes or write scopes from another consumer.
export function approveMemoryIngest(input: MemoryIngestInput): MemoryIngestInput {
  const context = input.context;
  if (!isGuardedContext(context) && !isBackgroundContext(context, "summary") && !isBackgroundContext(context, "memory_extraction")) throw new SocialOutputSuppressed();
  const scope = isGuardedContext(context) ? context.scope : context.messages[0]!;
  if (scope.guildId !== input.guildId || scope.channelId !== input.channelId || input.proposals.length > 32 ||
      !["live", "consolidation"].includes(input.source)) throw new SocialOutputSuppressed();
  const { context: _context, ...material } = input;
  const batch = Object.freeze({ ...immutableSnapshot(material), context }); batches.add(batch); return batch;
}

export function requireApprovedMemoryIngest(input: MemoryIngestInput): void {
  if (input.context !== undefined && !batches.has(input)) throw new SocialOutputSuppressed();
}

export function approveRelationIngest(input: MemoryRelationIngestInput): MemoryRelationIngestInput {
  const context = input.context;
  if (!isGuardedContext(context) && !isBackgroundContext(context, "summary") && !isBackgroundContext(context, "memory_extraction")) throw new SocialOutputSuppressed();
  const scope = isGuardedContext(context) ? context.scope : context.messages[0]!;
  if (scope.guildId !== input.guildId || scope.channelId !== input.channelId || input.proposals.length > 32) throw new SocialOutputSuppressed();
  const { context: _context, ...material } = input;
  const batch = Object.freeze({ ...immutableSnapshot(material), context }); relations.add(batch); return batch;
}
export function requireApprovedRelationIngest(input: MemoryRelationIngestInput): void {
  if (input.context !== undefined && !relations.has(input)) throw new SocialOutputSuppressed();
}
