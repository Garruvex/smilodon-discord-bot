import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Message } from "discord.js";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hashContent } from "../../src/application/assets/content-hash.js";
import type { ContextProvenance } from "../../src/application/chat/context-provenance.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import type { MessageOriginRecord } from "../../src/application/chat/message-origin-store.js";
import { SessionMessageOriginStore, sessionOriginLimits } from "../../src/application/chat/session-message-origins.js";
import type { ProvenanceInput } from "../../src/application/provenance/provenance-graph.js";
import { ProvenanceShadowWriter, withProvenanceShadow } from "../../src/application/provenance/provenance-shadow.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { ChatTurnSupport, type ChatDeliveryPayload } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";
import { SqliteMessageOriginStore } from "../../src/infrastructure/persistence/sqlite-message-origin-store.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); vi.useRealTimers(); });

function storage(): { graph: SqliteProvenanceGraphStore; origins: SqliteMessageOriginStore; revocations: SqliteMessageRevocationStore } {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-shadow-"))); close.push(() => connection.close());
  return { graph: new SqliteProvenanceGraphStore(connection.database), origins: new SqliteMessageOriginStore(connection.database),
    revocations: new SqliteMessageRevocationStore(connection.database) };
}

const hash = (letter: string): string => letter.repeat(64);
const dependency = (messageId: string, authorId = "alice"): ContextProvenance["dependencies"][number] =>
  ({ guildId: "guild", channelId: "channel", messageId, authorId, timestampMs: 1_000, representationHash: hash("b") });
const replyRecord = (messageId: string, dependencies: ContextProvenance["dependencies"]): MessageOriginRecord => ({
  guildId: "guild", channelId: "channel", messageId, origin: "chat", sourceMessageId: "q", createdAt: 5_000,
  contextProvenance: { version: 1, coverage: "complete", audience: { guildId: "guild", channelId: "channel", userId: null }, outputHash: hash("a"), dependencies, unresolved: [] },
});
const input = (messageId: string, direct: boolean, origin: "human" | "chat" | null, carriers: string[] = []): ProvenanceInput => ({ messageId, origin, direct, carriers });

describe("ProvenanceShadowWriter", () => {
  it("links an earlier reply as one parent and leaves out what it already covers", async () => {
    const { graph } = storage(); const writer = new ProvenanceShadowWriter(graph);
    expect(await writer.recordReplyPart(replyRecord("r1", [dependency("m")]), [input("m", true, "human")])).toBe("published");
    expect(await writer.recordReplyPart(replyRecord("r2", [dependency("q"), dependency("r1", "bot"), dependency("m")]),
      [input("q", true, "human"), input("r1", true, "chat"), input("m", false, null, ["reply:r1"])])).toBe("published");
    const r1 = (await graph.current("guild", "channel", "reply_part", "r1"))!.revisionId;
    const r2 = (await graph.current("guild", "channel", "reply_part", "r2"))!.revisionId;
    const messages = await graph.currentMany("guild", "channel", "message", ["q", "m", "r1"]);
    expect((await graph.parents(r2)).map((parent) => parent.revisionId).sort()).toEqual([r1, messages.get("q")!].sort());
    expect(messages.has("r1")).toBe(false);
  });

  it("keeps a direct edge, marked flattened, when the carrier is not a parent in the graph", async () => {
    const { graph } = storage(); const writer = new ProvenanceShadowWriter(graph);
    // r0 predates the graph; m is carried by r0 and by a claim, neither of which is a graph parent.
    expect(await writer.recordReplyPart(replyRecord("r2", [dependency("q"), dependency("r0", "bot"), dependency("m"), dependency("n")]),
      [input("q", true, "human"), input("r0", true, "chat"), input("m", false, null, ["reply:r0"]), input("n", false, null, ["claim:c1"])])).toBe("published");
    const r2 = (await graph.current("guild", "channel", "reply_part", "r2"))!.revisionId;
    const messages = await graph.currentMany("guild", "channel", "message", ["q", "r0", "m", "n"]);
    expect((await graph.parents(r2)).map((parent) => parent.revisionId).sort()).toEqual([...messages.values()].sort());
  });

  it("publishes nothing for a reply whose input is already revoked, and a later revocation reaches through replies", async () => {
    const { graph, revocations } = storage(); const writer = new ProvenanceShadowWriter(graph);
    await writer.recordReplyPart(replyRecord("r1", [dependency("m")]), [input("m", true, "human")]);
    await writer.recordReplyPart(replyRecord("r2", [dependency("r1", "bot"), dependency("m")]), [input("r1", true, "chat"), input("m", false, null, ["reply:r1"])]);
    await revocations.revoke({ guildId: "guild", channelId: "channel", messageIds: ["m"], revokedAt: 6_000 });
    // r3 cites only r2; m is two replies back.
    expect(await writer.recordReplyPart(replyRecord("r3", [dependency("r2", "bot"), dependency("m")]), [input("r2", true, "chat"), input("m", false, null, ["reply:r2"])])).toBe("refused");
    expect(await writer.recordReplyPart(replyRecord("r4", [dependency("m")]), [input("m", true, "human")])).toBe("refused");
    expect(await graph.currentMany("guild", "channel", "reply_part", ["r3", "r4"])).toEqual(new Map());
  });

  it("skips records without a complete reply proof", async () => {
    const { graph } = storage(); const writer = new ProvenanceShadowWriter(graph);
    const partial = replyRecord("r", [dependency("m")]); partial.contextProvenance = { ...partial.contextProvenance!, coverage: "partial" };
    expect(await writer.recordReplyPart(partial, [input("m", true, "human")])).toBe("skipped");
    expect(await writer.recordReplyPart({ ...replyRecord("r", [dependency("m")]), contextProvenance: null }, [])).toBe("skipped");
  });
});

describe("GuardedConversationContext.graphInputs", () => {
  it("marks an earlier reply as a direct input and what its proof brought in as carried by it", async () => {
    const fixture = guardedFixture(guardedEvent("current", 4_000, "and you?"));
    fixture.add(guardedEvent("old", 1_000, "I like tea"));
    const reply = guardedEvent("reply", 2_000, "tea is nice", "bot");
    fixture.add(reply);
    fixture.sources.get("reply")!.origin = "chat";
    fixture.sources.get("reply")!.provenance = { version: 1, coverage: "complete", audience: { guildId: "guild", channelId: "channel", userId: null },
      outputHash: hashContent("tea is nice"), dependencies: [{ ...dependency("hidden"), timestampMs: 500 }], unresolved: [] };
    fixture.port.sourcesAllowed = (cited): Promise<readonly boolean[]> => Promise.resolve(cited.map(() => true));
    const lease = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12_000, burstIds: [] });
    const inputs = new Map(lease.graphInputs().map((entry) => [entry.messageId, entry]));
    expect(inputs.get("current")).toMatchObject({ direct: true, origin: "human" });
    expect(inputs.get("reply")).toMatchObject({ direct: true, origin: "chat" });
    expect(inputs.get("hidden")).toMatchObject({ direct: false, carriers: ["reply:reply"] });
  });
});

const oneMiB = 1024 * 1024;
const source = { id: "current", guildId: "guild", channelId: "channel", author: { bot: false } } as Message;
const silent = { warn: vi.fn(), info: vi.fn(), child: () => silent } as unknown as Logger;

describe("delivery dual-writes the graph", () => {
  it("records only the part that was delivered, and a graph failure never resends it", async () => {
    const { graph, origins } = storage();
    const failures: unknown[] = [];
    const store = withProvenanceShadow(origins, new ProvenanceShadowWriter(graph), (error) => failures.push(error));
    const support = new ChatTurnSupport(silent, null, store);
    const lease = await GuardedConversationContext.open(guardedFixture().port, { count: 40, budget: 12_000, burstIds: [] });
    const first = vi.fn((payload: ChatDeliveryPayload) => Promise.resolve({ id: "part-1", content: payload.content } as Message));
    const rest = vi.fn(() => Promise.reject(Object.assign(new Error("bad request"), { status: 400 })));
    await support.deliverChatResponse({ sender: { first, rest }, text: "word ".repeat(900), sources: [], images: [], emptyFallbackContent: "empty",
      maxImageAggregateBytes: oneMiB, contextLease: lease, sourceMessage: source });
    expect(rest).toHaveBeenCalledOnce();
    const parts = await graph.currentMany("guild", "channel", "reply_part", ["part-1", "part-2"]);
    expect([...parts.keys()]).toEqual(["part-1"]);
    expect((await graph.parents(parts.get("part-1")!)).map((parent) => parent.revisionId))
      .toEqual([...(await graph.currentMany("guild", "channel", "message", ["current"])).values()]);
    expect(failures).toEqual([]);

    // The graph write fails: the reply was still delivered once and its v1 origin kept.
    vi.spyOn(graph, "publish").mockRejectedValueOnce(new Error("graph unavailable"));
    const again = vi.fn((payload: ChatDeliveryPayload) => Promise.resolve({ id: "part-3", content: payload.content } as Message));
    const second = await GuardedConversationContext.open(guardedFixture().port, { count: 40, budget: 12_000, burstIds: [] });
    await support.deliverChatResponse({ sender: { first: again, rest: vi.fn() }, text: "short", sources: [], images: [], emptyFallbackContent: "empty",
      maxImageAggregateBytes: oneMiB, contextLease: second, sourceMessage: source });
    expect(again).toHaveBeenCalledOnce();
    expect(failures).toHaveLength(1);
    expect((await origins.find("guild", "channel", "part-3"))?.contextProvenance?.coverage).toBe("complete");
    expect(await graph.current("guild", "channel", "reply_part", "part-3")).toBeNull();
  });

  it("writes no durable edge for a session-only reply, so it cannot be recovered once the session expires", async () => {
    const { graph, origins } = storage();
    let now = 10_000;
    const session = new SessionMessageOriginStore(withProvenanceShadow(origins, new ProvenanceShadowWriter(graph), () => undefined), () => now);
    const support = new ChatTurnSupport(silent, null, session);
    const fixture = guardedFixture(); fixture.port.retention = "session"; fixture.port.persist = false;
    const lease = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12_000, burstIds: [] });
    vi.useFakeTimers({ now, toFake: ["Date"] });
    await support.deliverChatResponse({ sender: { first: (payload) => Promise.resolve({ id: "session-reply", content: payload.content } as Message), rest: vi.fn() },
      text: "just between us", sources: [], images: [], emptyFallbackContent: "empty", maxImageAggregateBytes: oneMiB, contextLease: lease, sourceMessage: source });
    expect((await session.find("guild", "channel", "session-reply"))?.contextProvenance?.coverage).toBe("complete");
    expect(await graph.current("guild", "channel", "reply_part", "session-reply")).toBeNull();
    now += sessionOriginLimits.ttlMs + 1; vi.setSystemTime(now);
    expect(await session.find("guild", "channel", "session-reply")).toBeNull();
    expect(await graph.currentMany("guild", "channel", "message", ["current"])).toEqual(new Map());
  });
});
