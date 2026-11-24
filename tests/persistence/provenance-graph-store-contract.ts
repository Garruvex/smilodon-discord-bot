import { describe, expect, it } from "vitest";

import type { MessageRevocationStore } from "../../src/application/chat/message-revocation-store.js";
import type { ProvenanceGraphStore, ProvenanceParent, ProvenancePublication } from "../../src/application/provenance/provenance-graph.js";

export interface ProvenanceGraphHarness {
  store: ProvenanceGraphStore;
  revocations: MessageRevocationStore;
  // Writes a revision row directly, bypassing the store, to set up states the store never produces.
  insertRevision(row: { id: string; channelId?: string; kind: string; artifactId: string; version: number; ordinal: number; state: "staged" | "published" }): Promise<void>;
  revisionCount(): Promise<number>;
  edgeCount(): Promise<number>;
  scopeOrdinal(guildId: string, channelId: string): Promise<number>;
  // Makes every later write to the current-version pointer fail, as an interrupted transaction would.
  failPointerWrites(): Promise<void>;
  // An edge to a parent that has no row, as a lost or out-of-order write would leave.
  insertDanglingEdge(childId: string, parentId: string): Promise<void>;
}

const hash = (letter: string): string => letter.repeat(64);
const message = (messageId: string, overrides: Partial<ProvenancePublication> = {}): ProvenancePublication => ({
  guildId: "guild", channelId: "channel", kind: "message", artifactId: messageId, version: 1, completeness: "complete",
  authorId: "alice", sourceTimestampMs: 1_000, representationHash: hash("b"), parents: [], publishedAt: 1_000, ...overrides,
});
const reply = (artifactId: string, parents: readonly ProvenanceParent[], overrides: Partial<ProvenancePublication> = {}): ProvenancePublication => ({
  guildId: "guild", channelId: "channel", kind: "reply_part", artifactId, version: 1, completeness: "complete", purpose: "reply",
  audienceUserId: null, outputHash: hash("a"), parents, publishedAt: 2_000, ...overrides,
});
const full = (revisionId: string): ProvenanceParent => ({ revisionId, projection: "full", representationHash: hash("c") });

async function published(store: ProvenanceGraphStore, input: ProvenancePublication): Promise<string> {
  const result = await store.publish(input);
  if (result.status !== "published") throw new Error(`expected publication, got ${result.reason}`);
  return result.revisionId;
}

export function provenanceGraphStoreContract(label: string, create: () => Promise<ProvenanceGraphHarness>): void {
  describe(`ProvenanceGraphStore contract (${label})`, () => {
    it("publishes a revision with its full parent set and moves the current pointer", async () => {
      const { store } = await create();
      const m = await published(store, message("m"));
      const q = await published(store, message("q"));
      const r1 = await published(store, reply("r1", [full(m)]));
      const r2 = await published(store, reply("r2", [full(r1), { revisionId: q, projection: "human_text:1000", representationHash: hash("d"), assetsHash: hash("e") }]));
      expect(await store.current("guild", "channel", "reply_part", "r2")).toEqual({ revisionId: r2, version: 1 });
      expect((await store.parents(r2)).sort((a, b) => a.revisionId.localeCompare(b.revisionId))).toEqual([full(r1), { revisionId: q, projection: "human_text:1000", representationHash: hash("d"), assetsHash: hash("e") }]
        .sort((a, b) => a.revisionId.localeCompare(b.revisionId)).map((parent) => ({ assetsHash: null, ...parent })));
      // A second version of the same output is a new revision; the pointer moves to it.
      const r2b = await published(store, reply("r2", [full(r1)], { version: 2, outputHash: hash("f") }));
      expect(r2b).not.toBe(r2);
      expect(await store.current("guild", "channel", "reply_part", "r2")).toEqual({ revisionId: r2b, version: 2 });
    });

    it("refuses missing, unpublished, other-scope and forward parents, and writes nothing", async () => {
      const harness = await create(); const { store } = harness;
      const m = await published(store, message("m"));
      await harness.insertRevision({ id: "staged", kind: "reply_part", artifactId: "staged", version: 1, ordinal: 50, state: "staged" });
      await harness.insertRevision({ id: "elsewhere", channelId: "other", kind: "message", artifactId: "x", version: 1, ordinal: 1, state: "published" });
      await harness.insertRevision({ id: "ahead", kind: "message", artifactId: "ahead", version: 1, ordinal: 1_000, state: "published" });
      const before = { revisions: await harness.revisionCount(), edges: await harness.edgeCount(), ordinal: await harness.scopeOrdinal("guild", "channel") };
      expect(await store.publish(reply("r", [full(m), full("missing")]))).toEqual({ status: "refused", reason: "missing_parent" });
      expect(await store.publish(reply("r", [full(m), full("staged")]))).toEqual({ status: "refused", reason: "unpublished_parent" });
      expect(await store.publish(reply("r", [full(m), full("elsewhere")]))).toEqual({ status: "refused", reason: "cross_scope_parent" });
      expect(await store.publish(reply("r", [full(m), full("ahead")]))).toEqual({ status: "refused", reason: "forward_parent" });
      expect({ revisions: await harness.revisionCount(), edges: await harness.edgeCount(), ordinal: await harness.scopeOrdinal("guild", "channel") }).toEqual(before);
      expect(await store.current("guild", "channel", "reply_part", "r")).toBeNull();
    });

    it("refuses a child of anything that reaches a revoked message, except through summary text", async () => {
      const { store, revocations } = await create();
      const m = await published(store, message("m"));
      const scan = await published(store, message("scan"));
      const r1 = await published(store, reply("r1", [full(m)]));
      const r2 = await published(store, reply("r2", [full(r1)]));
      const digest = await published(store, reply("digest", [{ revisionId: scan, projection: "background_text:500", representationHash: hash("c") }], { kind: "claim" }));
      await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["m", "scan"], revokedAt: 3_000 });
      // r3 never cites m directly; m is reached through r2 and r1.
      expect(await store.publish(reply("r3", [full(r2)]))).toEqual({ status: "refused", reason: "revoked_ancestry" });
      expect(await store.publish(message("m", { version: 2 }))).toEqual({ status: "refused", reason: "revoked_ancestry" });
      // Built only from summary text: the guild's retention policy keeps it.
      expect((await store.publish(reply("r4", [full(digest)]))).status).toBe("published");
      // The same message used as conversation still blocks.
      expect(await store.publish(reply("r5", [{ revisionId: scan, projection: "human_text:500", representationHash: hash("c") }]))).toEqual({ status: "refused", reason: "revoked_ancestry" });
    });

    it("treats a deleted bot reply as revoked, like any other Discord message", async () => {
      const { store, revocations } = await create();
      const m = await published(store, message("m"));
      const r1 = await published(store, reply("r1", [full(m)]));
      await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["r1"], revokedAt: 3_000 });
      expect(await store.publish(reply("r2", [full(r1)]))).toEqual({ status: "refused", reason: "revoked_ancestry" });
      expect(await store.publish(reply("r1", [full(m)], { version: 2 }))).toEqual({ status: "refused", reason: "revoked_ancestry" });
      // A claim is not a Discord message; a revocation keyed by its ID means nothing for it.
      const claim = await published(store, reply("c1", [full(m)], { kind: "claim" }));
      await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["c1"], revokedAt: 4_000 });
      expect((await store.publish(reply("r3", [full(claim)]))).status).toBe("published");
    });

    it("refuses a stale or repeated version without moving the pointer", async () => {
      const { store } = await create();
      const m = await published(store, message("m"));
      const v2 = await published(store, reply("r", [full(m)], { version: 2 }));
      expect(await store.publish(reply("r", [full(m)], { version: 1 }))).toEqual({ status: "refused", reason: "stale_version" });
      expect(await store.publish(reply("r", [full(m)], { version: 2 }))).toEqual({ status: "refused", reason: "stale_version" });
      expect(await store.current("guild", "channel", "reply_part", "r")).toEqual({ revisionId: v2, version: 2 });
    });

    it("leaves neither a partial parent set nor an advanced pointer when the transaction is interrupted", async () => {
      const harness = await create(); const { store } = harness;
      const m = await published(store, message("m"));
      const r1 = await published(store, reply("r", [full(m)]));
      const before = { revisions: await harness.revisionCount(), edges: await harness.edgeCount(), ordinal: await harness.scopeOrdinal("guild", "channel") };
      await harness.failPointerWrites();
      await expect(store.publish(reply("r", [full(m), full(r1)], { version: 2 }))).rejects.toThrow();
      expect({ revisions: await harness.revisionCount(), edges: await harness.edgeCount(), ordinal: await harness.scopeOrdinal("guild", "channel") }).toEqual(before);
      expect(await store.current("guild", "channel", "reply_part", "r")).toEqual({ revisionId: r1, version: 1 });
    });

    it("gives each Discord message one revision, reused afterwards, and none once revoked", async () => {
      const harness = await create(); const { store, revocations } = harness;
      await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["gone"], revokedAt: 500 });
      const sources = [{ messageId: "a", authorId: "alice", timestampMs: 1 }, { messageId: "b", authorId: "bob", timestampMs: 2 }, { messageId: "gone", authorId: "alice", timestampMs: 3 }];
      const first = await store.ensureMessages("guild", "channel", [...sources, sources[0]!], 1_000);
      expect([...first.keys()].sort()).toEqual(["a", "b"]);
      expect(await harness.scopeOrdinal("guild", "channel")).toBe(2);
      const again = await store.ensureMessages("guild", "channel", sources, 2_000);
      expect(again).toEqual(first);
      expect(await harness.revisionCount()).toBe(2);
      // Reused revisions are valid parents, and a later revocation still reaches them.
      expect((await store.publish(reply("r", [full(first.get("a")!), full(first.get("b")!)]))).status).toBe("published");
      await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["a"], revokedAt: 3_000 });
      expect([...(await store.ensureMessages("guild", "channel", sources, 4_000)).keys()]).toEqual(["b"]);
      expect(await store.currentMany("guild", "channel", "reply_part", ["r", "absent"])).toEqual(new Map([["r", expect.any(String)]]));
    });

    it("retracts the current pointer only while it still names the given revision", async () => {
      const { store } = await create();
      const m = await published(store, message("m"));
      const v1 = await published(store, reply("r", [full(m)]));
      const v2 = await published(store, reply("r", [full(m)], { version: 2 }));
      expect(await store.retract("guild", "channel", "reply_part", "r", v1)).toBe(false);
      expect(await store.current("guild", "channel", "reply_part", "r")).toEqual({ revisionId: v2, version: 2 });
      expect(await store.retract("guild", "channel", "reply_part", "r", v2)).toBe(true);
      expect(await store.current("guild", "channel", "reply_part", "r")).toBeNull();
      // The revision stays, so what was built on it keeps its ancestry.
      expect(await store.parents(v2)).toEqual([{ ...full(m), assetsHash: null }]);
    });

    it("checks many candidates' ancestry at once and names why one is not admissible", async () => {
      const harness = await create(); const { store, revocations } = harness;
      const m = await published(store, message("m")); const q = await published(store, message("q")); const n = await published(store, message("n"));
      const r1 = await published(store, reply("r1", [full(m)]));
      const r2 = await published(store, reply("r2", [full(r1), full(q)]));
      const r3 = await published(store, reply("r3", [full(r1)]));
      const other = await published(store, reply("other", [full(n)]));
      const check = (revisionIds: string[], audienceUserId: string | null = null, budget = 1_000): ReturnType<typeof store.checkAncestry> =>
        store.checkAncestry({ guildId: "guild", channelId: "channel", revisionIds, audienceUserId, budget });
      // Shared ancestors: r2 and r3 both reach r1 and m.
      expect(await check([r2, r3, r2])).toEqual(new Map([[r2, { admitted: true }], [r3, { admitted: true }]]));
      expect(await check(["unknown"])).toEqual(new Map([["unknown", { admitted: false, reasons: ["missing"] }]]));
      // A private claim made for alice may feed a read for alice only.
      const privateClaim = await published(store, reply("c", [full(n)], { kind: "claim", audienceUserId: "alice" }));
      const fromPrivate = await published(store, reply("r4", [full(privateClaim)]));
      expect((await check([fromPrivate], "alice")).get(fromPrivate)).toEqual({ admitted: true });
      expect((await check([fromPrivate], null)).get(fromPrivate)).toEqual({ admitted: false, reasons: ["audience"] });
      expect((await check([fromPrivate], "bob")).get(fromPrivate)).toEqual({ admitted: false, reasons: ["audience"] });
      // A missing parent rejects only the candidate that reaches it.
      const broken = await published(store, reply("r5", [full(q)]));
      await harness.insertDanglingEdge(broken, "lost-parent");
      const mixed = await check([broken, other]);
      expect(mixed.get(broken)).toEqual({ admitted: false, reasons: ["missing"] });
      expect(mixed.get(other)).toEqual({ admitted: true });
      // A revoked ancestor two replies back rejects both descendants and nothing else.
      await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["m"], revokedAt: 9_000 });
      const after = await check([r2, r3, other]);
      expect(after.get(r2)).toEqual({ admitted: false, reasons: ["revoked"] });
      expect(after.get(r3)).toEqual({ admitted: false, reasons: ["revoked"] });
      expect(after.get(other)).toEqual({ admitted: true });
    });

    it("lists the Discord messages each root reaches, with author and time, once per root", async () => {
      const { store } = await create();
      const m = await published(store, message("m")); const q = await published(store, message("q", { authorId: "bob", sourceTimestampMs: 2_000 }));
      const r1 = await published(store, reply("r1", [full(m)]));
      const r2 = await published(store, reply("r2", [full(r1), full(q), full(m)]));
      const lone = await published(store, reply("lone", [full(q)]));
      const reached = await store.ancestorMessages("guild", "channel", [r2, lone, r2, "unknown"]);
      const sorted = (root: string): unknown => [...(reached.get(root) ?? [])].sort((a, b) => a.messageId.localeCompare(b.messageId));
      expect(sorted(r2)).toEqual([{ messageId: "m", authorId: "alice", timestampMs: 1_000 }, { messageId: "q", authorId: "bob", timestampMs: 2_000 }]);
      expect(sorted(lone)).toEqual([{ messageId: "q", authorId: "bob", timestampMs: 2_000 }]);
      expect(reached.has("unknown")).toBe(false);
      // Another channel's roots reach nothing here.
      expect((await store.ancestorMessages("guild", "elsewhere", [r2])).size).toBe(0);
    });

    it("rejects a candidate whose dense ancestry exceeds the traversal budget", async () => {
      const { store } = await create();
      const sources = await Promise.all(Array.from({ length: 30 }, (_value, index) => published(store, message(`m${index}`))));
      let previous: string | null = null;
      for (let index = 0; index < 8; index++) {
        previous = await published(store, reply(`r${index}`, [...sources.map(full), ...(previous ? [full(previous)] : [])]));
      }
      const small = await published(store, reply("small", [full(sources[0]!)]));
      const check = (budget: number): ReturnType<typeof store.checkAncestry> => store.checkAncestry({ guildId: "guild", channelId: "channel", revisionIds: [previous!, small], audienceUserId: null, budget });
      // Every reply cites all 30 messages and the previous reply: 38 distinct revisions however many paths.
      expect((await check(38)).get(previous!)).toEqual({ admitted: true });
      const tight = await check(20);
      expect(tight.get(previous!)).toEqual({ admitted: false, reasons: ["budget"] });
      expect(tight.get(small)).toEqual({ admitted: true });
    });

    it("shares the scope row with revocation without either overwriting the other", async () => {
      const harness = await create(); const { store, revocations } = harness;
      const m = await published(store, message("m"));
      await Promise.all([revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["unrelated"], revokedAt: 3_000 }),
        store.publish(reply("r", [full(m)])), store.publish(message("q"))]);
      expect(await revocations.revision("guild", "channel")).toBe(1);
      expect(await harness.scopeOrdinal("guild", "channel")).toBe(3);
      await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["another"], revokedAt: 4_000 });
      expect(await harness.scopeOrdinal("guild", "channel")).toBe(3);
    });
  });
}
