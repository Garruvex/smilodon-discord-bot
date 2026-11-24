import { describe, expect, it } from "vitest";
import type { MessageRevocationStore } from "../../src/application/chat/message-revocation-store.js";

export function messageRevocationStoreContract(label: string, createStore: () => Promise<MessageRevocationStore>): void {
  describe(`MessageRevocationStore contract (${label})`, () => {
    it("revokes by guild, channel and message and queues cleanup in the same commit", async () => {
      const store = await createStore();
      expect(await store.revision("guild", "channel")).toBe(0);
      const result = await store.revoke({ guildId: "guild", channelId: "channel", messageIds: ["m1"], revokedAt: 1_000 });
      expect(result).toEqual({ revoked: ["m1"], revision: 1 });
      expect(await store.revision("guild", "channel")).toBe(1);
      expect(await store.revoked([
        { guildId: "guild", channelId: "channel", messageId: "m1" },
        { guildId: "guild", channelId: "channel", messageId: "m2" },
        // The same message ID in another channel or guild is a different key.
        { guildId: "guild", channelId: "other", messageId: "m1" },
        { guildId: "other", channelId: "channel", messageId: "m1" },
      ])).toEqual([true, false, false, false]);
      expect(await store.cleanupWork([{ guildId: "guild", channelId: "channel", messageId: "m1" }, { guildId: "guild", channelId: "channel", messageId: "m2" }]))
        .toEqual([{ guildId: "guild", channelId: "channel", messageId: "m1", state: "pending", attempts: 0, nextAt: 1_000 }, null]);
    });

    it("treats a repeated revocation as a no-op", async () => {
      const store = await createStore();
      await store.revoke({ guildId: "guild", channelId: "channel", messageIds: ["m1"], revokedAt: 1_000 });
      // A duplicate gateway event changes nothing: no new revocation, no revision bump, no second cleanup row.
      expect(await store.revoke({ guildId: "guild", channelId: "channel", messageIds: ["m1"], revokedAt: 9_000 })).toEqual({ revoked: [], revision: 1 });
      expect(await store.revoke({ guildId: "guild", channelId: "channel", messageIds: [], revokedAt: 9_000 })).toEqual({ revoked: [], revision: 1 });
      expect((await store.cleanupWork([{ guildId: "guild", channelId: "channel", messageId: "m1" }]))[0]?.nextAt).toBe(1_000);
    });

    it("revokes a bulk delete in one revision and only adds the new IDs", async () => {
      const store = await createStore();
      await store.revoke({ guildId: "guild", channelId: "channel", messageIds: ["m1"], revokedAt: 1_000 });
      const ids = Array.from({ length: 1_200 }, (_unused, index) => `bulk-${index}`);
      const result = await store.revoke({ guildId: "guild", channelId: "channel", messageIds: ["m1", ...ids, "bulk-0"], revokedAt: 2_000 });
      expect([...result.revoked].sort()).toEqual([...ids].sort());
      expect(result.revision).toBe(2);
      const keys = [...ids, "m1", "never"].map((messageId) => ({ guildId: "guild", channelId: "channel", messageId }));
      expect(await store.revoked(keys)).toEqual([...ids.map(() => true), true, false]);
      expect((await store.cleanupWork(keys)).filter((work) => work?.state === "pending")).toHaveLength(1_201);
    });

    it("keeps revisions per channel and answers mixed-scope lookups in order", async () => {
      const store = await createStore();
      await store.revoke({ guildId: "guild", channelId: "a", messageIds: ["x"], revokedAt: 1_000 });
      await store.revoke({ guildId: "guild", channelId: "a", messageIds: ["y"], revokedAt: 1_100 });
      await store.revoke({ guildId: "guild", channelId: "b", messageIds: ["z"], revokedAt: 1_200 });
      expect(await store.revision("guild", "a")).toBe(2);
      expect(await store.revision("guild", "b")).toBe(1);
      expect(await store.revision("guild", "c")).toBe(0);
      expect(await store.revoked([
        { guildId: "guild", channelId: "b", messageId: "z" },
        { guildId: "guild", channelId: "a", messageId: "z" },
        { guildId: "guild", channelId: "a", messageId: "x" },
      ])).toEqual([true, false, true]);
      expect(await store.revoked([])).toEqual([]);
    });

    it("serializes concurrent revocations in one channel", async () => {
      const store = await createStore();
      const results = await Promise.all(Array.from({ length: 8 }, (_unused, index) =>
        store.revoke({ guildId: "guild", channelId: "channel", messageIds: [`c${index}`, "shared"], revokedAt: 1_000 + index })));
      // Each message is revoked exactly once, and every call that revoked something got its own revision.
      expect(results.flatMap((result) => result.revoked).filter((id) => id === "shared")).toHaveLength(1);
      expect(results.flatMap((result) => result.revoked)).toHaveLength(9);
      expect(new Set(results.map((result) => result.revision)).size).toBe(8);
      expect(await store.revision("guild", "channel")).toBe(8);
    });
  });
}
