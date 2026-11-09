import { DefaultMemoryEngine } from "../memory/memory-engine.js";
import type { MemoryEngine, MemoryRecallInput } from "../memory/memory.js";
import { isGuardedContext } from "../chat/guarded-conversation-context.js";
import { isBackgroundContext } from "./guarded-background-context.js";
import { requireApprovedMemoryIngest, requireApprovedRelationIngest } from "./approved-memory-ingest.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import { immutableSnapshot } from "./immutable-snapshot.js";

// The core retains context-free domain behavior for repository/algorithm tests.
// Composition exposes only this facade: no live read/write can select it.
export function createGuardedMemoryEngine(...dependencies: ConstructorParameters<typeof DefaultMemoryEngine>): MemoryEngine {
  const core = new DefaultMemoryEngine(...dependencies);
  const now = dependencies[9] ?? ((): number => Date.now());
  const gateway: MemoryEngine = {
    recall: async (input) => {
      if (!isGuardedContext(input.context)) throw new SocialOutputSuppressed();
      if (input.guildId !== input.context.scope.guildId || input.channelId !== input.context.scope.channelId ||
        input.userId !== (input.context.scope.actorId ?? input.context.current.authorId)) throw new SocialOutputSuppressed();
      if (!input.context.durableWritesAllowed) {
        if (!await input.context.validate()) throw new SocialOutputSuppressed();
        return { memories: [], causalChains: [] };
      }
      const { context, query, ...material } = input;
      const request: MemoryRecallInput = { ...immutableSnapshot(material), context, ...(query ? { query } : {}), now: now() };
      return await core.recall(request);
    },
    ingest: async (input) => {
      if (!isGuardedContext(input.context) && !isBackgroundContext(input.context, "summary") && !isBackgroundContext(input.context, "memory_extraction")) throw new SocialOutputSuppressed();
      if (isGuardedContext(input.context) && !input.context.durableWritesAllowed) throw new SocialOutputSuppressed();
      requireApprovedMemoryIngest(input); return await core.ingest(input);
    },
    ingestRelations: async (input) => {
      if (!isGuardedContext(input.context) && !isBackgroundContext(input.context, "summary") && !isBackgroundContext(input.context, "memory_extraction")) throw new SocialOutputSuppressed();
      if (isGuardedContext(input.context) && !input.context.durableWritesAllowed) throw new SocialOutputSuppressed();
      requireApprovedRelationIngest(input); return await core.ingestRelations(input);
    },
    // Human data management has separate command/action authorization and
    // never supplies model context through this surface.
    listUserMemories: core.listUserMemories.bind(core), forget: core.forget.bind(core),
    listSources: core.listSources.bind(core), listPromptSources: core.listPromptSources.bind(core),
  };
  return Object.freeze(gateway);
}
