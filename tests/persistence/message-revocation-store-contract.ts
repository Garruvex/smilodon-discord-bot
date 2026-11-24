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

    it("reports the guild's most recent revocation time", async () => {
      const store = await createStore();
      expect(await store.latestRevocationAt("guild")).toBeNull();
      await store.revoke({ guildId: "guild", channelId: "a", messageIds: ["m1"], revokedAt: 1_000 });
      await store.revoke({ guildId: "guild", channelId: "b", messageIds: ["m2"], revokedAt: 3_000 });
      await store.revoke({ guildId: "other", channelId: "a", messageIds: ["m3"], revokedAt: 9_000 });
      expect(await store.latestRevocationAt("guild")).toBe(3_000);
      expect(await store.latestRevocationAt("other")).toBe(9_000);
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

    it("claims due cleanup under a lease and runs a first pass, then a settle pass", async () => {
      const store = await createStore();
      await store.revoke({ guildId: "guild", channelId: "channel", messageIds: ["m1", "m2"], revokedAt: 1_000 });
      // Nothing is due before the revocation time.
      expect(await store.claimCleanup({ now: 999, limit: 10, leaseMs: 100 })).toEqual([]);
      const claims = await store.claimCleanup({ now: 1_000, limit: 1, leaseMs: 100 });
      expect(claims).toEqual([{ guildId: "guild", channelId: "channel", messageId: "m1", pass: "first", attempts: 0, leaseUntil: 1_100 }]);
      // A claimed row is not handed out again while its lease runs.
      const second = await store.claimCleanup({ now: 1_050, limit: 10, leaseMs: 100 });
      expect(second.map((claim) => claim.messageId)).toEqual(["m2"]);
      expect(await store.completeCleanup(claims[0]!, { now: 1_060, settleMs: 500 })).toBe(true);
      expect((await store.cleanupWork([claims[0]!]))[0]).toMatchObject({ state: "settling", nextAt: 1_560 });
      // m2's lease ran out at 1,150 without completing, so it is handed out again for its first pass.
      // m1's settle pass is not due until 1,560.
      const [m2] = await store.claimCleanup({ now: 1_559, limit: 10, leaseMs: 100 });
      expect(m2).toMatchObject({ messageId: "m2", pass: "first", leaseUntil: 1_659 });
      const settle = await store.claimCleanup({ now: 1_560, limit: 10, leaseMs: 100 });
      expect(settle.map((claim) => [claim.messageId, claim.pass])).toEqual([["m1", "settle"]]);
      const m1 = settle[0]!;
      expect(await store.completeCleanup(m1, { now: 1_600, settleMs: 500 })).toBe(true);
      expect((await store.cleanupWork([m1]))[0]).toMatchObject({ state: "done" });
      expect(await store.claimCleanup({ now: 10_000, limit: 10, leaseMs: 100 })).toEqual([{ ...m2!, leaseUntil: 10_100 }]);
    });

    it("retries failed cleanup later and recovers an abandoned claim", async () => {
      const store = await createStore();
      await store.revoke({ guildId: "guild", channelId: "channel", messageIds: ["m1"], revokedAt: 1_000 });
      const [claim] = await store.claimCleanup({ now: 1_000, limit: 10, leaseMs: 100 });
      expect(await store.retryCleanup(claim!, { retryAt: 5_000 })).toBe(true);
      expect((await store.cleanupWork([claim!]))[0]).toMatchObject({ state: "pending", attempts: 1, nextAt: 5_000 });
      expect(await store.claimCleanup({ now: 4_999, limit: 10, leaseMs: 100 })).toEqual([]);
      const [retried] = await store.claimCleanup({ now: 5_000, limit: 10, leaseMs: 100 });
      expect(retried).toMatchObject({ pass: "first", attempts: 1, leaseUntil: 5_100 });
      // The worker that held it died. Once the lease expires another claim takes over, and the
      // stale holder can no longer complete or retry it.
      const [recovered] = await store.claimCleanup({ now: 5_100, limit: 10, leaseMs: 100 });
      expect(recovered).toMatchObject({ messageId: "m1", pass: "first", leaseUntil: 5_200 });
      expect(await store.completeCleanup(retried!, { now: 5_150, settleMs: 500 })).toBe(false);
      expect(await store.retryCleanup(retried!, { retryAt: 9_000 })).toBe(false);
      expect(await store.completeCleanup(recovered!, { now: 5_150, settleMs: 500 })).toBe(true);
    });

    it("hands each due row to only one of several concurrent claimers", async () => {
      const store = await createStore();
      await store.revoke({ guildId: "guild", channelId: "channel", messageIds: Array.from({ length: 40 }, (_unused, index) => `m${index}`), revokedAt: 1_000 });
      const claims = (await Promise.all(Array.from({ length: 4 }, () => store.claimCleanup({ now: 2_000, limit: 15, leaseMs: 100 })))).flat();
      expect(claims).toHaveLength(40);
      expect(new Set(claims.map((claim) => claim.messageId)).size).toBe(40);
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
