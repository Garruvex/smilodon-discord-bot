import { hashContent } from "../assets/content-hash.js";
import { callbackProofPayload, callbackState } from "../chat/character-callbacks.js";
import type { RevocationCleanupStep } from "../chat/deleted-message-revocations.js";
import type { MemoryRepository } from "../memory/memory.js";
import { memoryClaimPayload } from "../memory/memory-claim-provenance.js";
import type { ProvenanceDescendant } from "./provenance-graph.js";

export interface GraphArtifactCleanupDependencies {
  memories: Pick<MemoryRepository, "findById" | "forget" | "compareAndSetStructuredValue" | "forgetRelations">;
  // Removes the channel's drift only while it is still the version given.
  forgetDrift: (guildId: string, channelId: string, versions: readonly { artifactId: string; outputHash: string }[]) => Promise<number>;
}

// Removes stored copies of artifacts whose current graph revision descends from a revoked message.
// Their proofs leave that ancestry to the graph, so the citation-based steps cannot find them. Each copy
// is removed only while it still holds the output the descending revision is bound to: a version rebuilt
// from other sources since then is kept.
// Aliases need no step here: an alias proof always cites its source message directly.
export function graphArtifactCleanup(dependencies: GraphArtifactCleanupDependencies): RevocationCleanupStep {
  return {
    name: "graph descendants",
    run: async (guildId, channelId, _messageIds, artifacts = []): Promise<number> => {
      let removed = 0;
      const bound = (kind: ProvenanceDescendant["kind"]): { artifactId: string; outputHash: string }[] =>
        artifacts.filter((artifact) => artifact.kind === kind && artifact.outputHash !== null).map(({ artifactId, outputHash }) => ({ artifactId, outputHash: outputHash! }));
      for (const { artifactId, outputHash } of bound("claim")) {
        const memory = await dependencies.memories.findById(guildId, artifactId);
        if (memory && hashContent(memoryClaimPayload(memory)) === outputHash) removed += await dependencies.memories.forget({ guildId, memoryId: memory.id });
      }
      for (const { artifactId, outputHash } of bound("callback")) {
        const memory = await dependencies.memories.findById(guildId, artifactId);
        const state = memory ? callbackState(memory) : null;
        if (!memory || !state || hashContent(callbackProofPayload(memory, state)) !== outputHash || !dependencies.memories.compareAndSetStructuredValue) continue;
        const { callback: _removed, ...rest } = memory.structuredValue as Record<string, unknown>;
        if (await dependencies.memories.compareAndSetStructuredValue({ guildId, memoryId: memory.id, updatedAt: memory.updatedAt, expected: memory.structuredValue, value: rest })) removed++;
      }
      const relations = bound("relation").map((artifact) => artifact.artifactId);
      if (relations.length && dependencies.memories.forgetRelations) removed += await dependencies.memories.forgetRelations({ guildId, channelId, payloadHashes: relations });
      const drift = bound("drift");
      if (drift.length) removed += await dependencies.forgetDrift(guildId, channelId, drift);
      return removed;
    },
  };
}
