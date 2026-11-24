import { describe, expect, it } from "vitest";
import type { PersonalMemoryExtractionJobInput, PersonalMemoryExtractionQueueStore } from "../../src/application/context/personal-memory-extraction-queue.js";

const job = (subjectId: string, batchId: string, ids: readonly string[], channelId = "channel"): PersonalMemoryExtractionJobInput => {
  const sourceMessages = ids.map((messageId, index) => ({ messageId, content: `${subjectId} says ${messageId}`, timestampMs: 1_000 + index }));
  return { guildId: "guild", channelId, batchId, subjectId, displayName: subjectId, content: sourceMessages.map((source) => source.content).join("\n"), sourceMessages };
};

// A5: a revoked message cancels every queued extraction job that would read it, including one
// waiting for a retry, so its text is not kept and it cannot later be published.
export function extractionQueueRevocationContract(label: string, createStore: () => Promise<PersonalMemoryExtractionQueueStore>): void {
  describe(`PersonalMemoryExtractionQueueStore deleteCitingMessages (${label})`, () => {
    it("deletes pending and retrying jobs that read a revoked message, and nothing else", async () => {
      const store = await createStore();
      await store.enqueueMany([job("alice", "b1", ["m1", "m2"]), job("bob", "b1", ["m3"]), job("carol", "b2", ["m4", "m1"]),
        job("alice", "b3", ["m1"], "elsewhere"), job("dave", "b4", ["m5"])], 1_000);
      await store.markFailed("guild", "channel", "b2", "carol", 1, 5_000, "provider error");
      await store.markDeadLettered("guild", "channel", "b4", "dave", "gave up");
      expect([...await store.deleteCitingMessages("guild", "channel", ["m1"])].sort()).toEqual(["alice", "carol"]);
      expect(await store.exists("guild", "channel", "b1", "alice")).toBe(false);
      expect(await store.exists("guild", "channel", "b2", "carol")).toBe(false);
      expect(await store.exists("guild", "channel", "b1", "bob")).toBe(true);
      expect(await store.exists("guild", "elsewhere", "b3", "alice")).toBe(true);
      expect(await store.exists("guild", "channel", "b4", "dave")).toBe(true);
      expect(await store.deleteCitingMessages("guild", "channel", ["m1"])).toEqual([]);
      expect(await store.deleteCitingMessages("guild", "channel", [])).toEqual([]);
    });
  });
}
