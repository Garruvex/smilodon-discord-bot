import { describe, expect, it } from "vitest";
import type { MessageOriginStore } from "../../src/application/chat/message-origin-store.js";
import type { ContextProvenance } from "../../src/application/chat/context-provenance.js";
import { hashContent } from "../../src/application/assets/content-hash.js";

const proof = (dependencies: ContextProvenance["dependencies"]): ContextProvenance => ({ version: 1, coverage: "complete",
  audience: { guildId: "guild", channelId: "channel", userId: null }, outputHash: hashContent("answer"), dependencies, unresolved: [] });
const dependency = (messageId: string, channelId = "channel", background = false): ContextProvenance["dependencies"][number] => ({
  guildId: "guild", channelId, messageId, authorId: "alice", timestampMs: 1, representationHash: hashContent(messageId),
  ...(background ? { projection: { kind: "background_text" as const, chars: 10 } } : {}) });

// A4 cleanup step: a revoked message loses its own origin row, and replies citing it as conversation
// lose their proof. Summary-only citations, other channels and other guilds are untouched.
export function messageOriginForgetContract(label: string, createStore: () => Promise<Required<Pick<MessageOriginStore, "forgetCitingMessages">> & MessageOriginStore>): void {
  describe(`MessageOriginStore forgetCitingMessages (${label})`, () => {
    it("removes revoked origins and clears proofs that cite them as conversation", async () => {
      const store = await createStore();
      const record = (messageId: string, dependencies: ContextProvenance["dependencies"], guildId = "guild", channelId = "channel"): Promise<void> =>
        store.record({ guildId, channelId, messageId, origin: "chat", sourceMessageId: "question", createdAt: 1, contextProvenance: { ...proof(dependencies), audience: { guildId, channelId, userId: null },
          dependencies: dependencies.map((entry) => ({ ...entry, guildId })) } });
      await record("deleted-reply", [dependency("question")]);
      await record("cites-deleted", [dependency("question"), dependency("deleted")]);
      await record("summary-only", [dependency("question"), dependency("deleted", "channel", true)]);
      await record("unrelated", [dependency("question")]);
      await record("other-guild", [dependency("question"), dependency("deleted")], "guild-2");
      expect(await store.forgetCitingMessages({ guildId: "guild", channelId: "channel", messageIds: ["deleted", "deleted-reply"] })).toBe(2);
      expect(await store.find("guild", "channel", "deleted-reply")).toBeNull();
      expect((await store.find("guild", "channel", "cites-deleted"))?.contextProvenance ?? null).toBeNull();
      expect((await store.find("guild", "channel", "cites-deleted"))?.origin).toBe("chat");
      expect((await store.find("guild", "channel", "summary-only"))?.contextProvenance).not.toBeNull();
      expect((await store.find("guild", "channel", "unrelated"))?.contextProvenance).not.toBeNull();
      expect((await store.find("guild-2", "channel", "other-guild"))?.contextProvenance).not.toBeNull();
      // Running it again is a no-op.
      expect(await store.forgetCitingMessages({ guildId: "guild", channelId: "channel", messageIds: ["deleted", "deleted-reply"] })).toBe(0);
    });
  });
}
