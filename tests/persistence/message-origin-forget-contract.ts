import { describe, expect, it } from "vitest";
import type { LegacyReplyProofSource } from "../../src/application/provenance/provenance-backfill.js";
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
type ContractStore = Required<Pick<MessageOriginStore, "forgetCitingMessages">> & MessageOriginStore & Pick<LegacyReplyProofSource, "pageReplyProofs">;
export function messageOriginForgetContract(label: string, createStore: () => Promise<ContractStore>): void {
  describe(`MessageOriginStore forgetCitingMessages (${label})`, () => {
    it("pages durable reply proofs in creation order for the graph backfill", async () => {
      const store = await createStore();
      const proof = { version: 1 as const, coverage: "complete" as const, audience: { guildId: "guild", channelId: "channel", userId: null }, outputHash: "a".repeat(64),
        dependencies: [{ guildId: "guild", channelId: "channel", messageId: "q", authorId: "alice", timestampMs: 1, representationHash: "b".repeat(64) }], unresolved: [] };
      for (const [messageId, createdAt, withProof] of [["p-b", 2_000, true], ["p-a", 2_000, true], ["p-c", 1_000, true], ["p-none", 1_500, false]] as const) {
        await store.record({ guildId: "guild", channelId: "channel", messageId, origin: "chat", sourceMessageId: "q", createdAt, contextProvenance: withProof ? proof : null });
      }
      const first = await store.pageReplyProofs(null, 2);
      expect(first.map((record) => record.messageId)).toEqual(["p-c", "p-a"]);
      expect(first[0]!.createdAt).toBe(1_000);
      const rest = await store.pageReplyProofs({ createdAt: first[1]!.createdAt, messageId: first[1]!.messageId }, 10);
      expect(rest.map((record) => record.messageId)).toEqual(["p-b"]);
    });

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
