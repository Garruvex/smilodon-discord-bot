import { describe, expect, it, vi } from "vitest";
import { SessionMessageOriginStore, sessionOriginLimits, withSessionMessageOrigins } from "../../src/application/chat/session-message-origins.js";
import { GuardedConversationContext, guardedAssetsHash, type GuardedContextSource } from "../../src/application/chat/guarded-conversation-context.js";
import type { MessageOriginRecord } from "../../src/application/chat/message-origin-store.js";
import type { ChatSessionExchange } from "../../src/application/chat/chat-state-store.js";
import { guardedFixture, guardedEvent } from "../helpers/guarded-context-fixture.js";

async function setup(): Promise<{ fixture: ReturnType<typeof guardedFixture>; record: MessageOriginRecord }> {
  const fixture = guardedFixture(guardedEvent("source", 1000, "SENSITIVE_USER_TEXT")); fixture.port.persist = false; fixture.port.retention = "session";
  const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 0, burstIds: [] });
  expect(context.provenance("reply")).toBeNull();
  return { fixture, record: { guildId: "guild", channelId: "channel", messageId: "reply", origin: "chat", sourceMessageId: "source", createdAt: 2000, contextProvenance: context.sessionProvenance("reply")! } };
}
describe("ephemeral confirmed message origins", () => {
  it("retains only bounded metadata in memory, with scope isolation and expiry", async () => {
    const { record } = await setup(); let now = 2000;
    const backend = { record: vi.fn(), find: vi.fn().mockResolvedValue(null) };
    const cache = new SessionMessageOriginStore(backend, () => now);
    await cache.recordSession(record);
    const stored = await cache.find("guild", "channel", "reply");
    expect(stored).toEqual(record); expect(JSON.stringify(stored)).not.toContain("SENSITIVE_USER_TEXT");
    expect(await cache.find("guild", "elsewhere", "reply")).toBeNull();
    expect(backend.record).not.toHaveBeenCalled();
    expect(() => { stored!.contextProvenance!.dependencies[0]!.authorId = "injected"; }).toThrow();
    now += sessionOriginLimits.ttlMs;
    expect(await cache.find("guild", "channel", "reply")).toBeNull();
    expect(await new SessionMessageOriginStore(backend, () => now).find("guild", "channel", "reply")).toBeNull();
  });
  it("evicts the oldest entries at the count cap and participates in forgetting", async () => {
    const { record } = await setup(); const backend = { record: vi.fn(), find: vi.fn().mockResolvedValue(null), invalidateContextSubject: vi.fn() };
    const cache = new SessionMessageOriginStore(backend, () => 2000);
    for (let index = 0; index <= sessionOriginLimits.entries; index++) await cache.recordSession({ ...record, messageId: `reply-${index}` });
    expect(await cache.find("guild", "channel", "reply-0")).toBeNull();
    expect(await cache.find("guild", "channel", `reply-${sessionOriginLimits.entries}`)).not.toBeNull();
    await cache.invalidateContextSubject("guild", "alice");
    expect(await cache.find("guild", "channel", `reply-${sessionOriginLimits.entries}`)).toBeNull();
    expect(backend.invalidateContextSubject).toHaveBeenCalledExactlyOnceWith("guild", "alice"); expect(backend.record).not.toHaveBeenCalled();
  });
  it("does not accept unproven or mismatched source bindings", async () => {
    const { record } = await setup(); const backend = { record: vi.fn(), find: vi.fn().mockResolvedValue(null) };
    const cache = new SessionMessageOriginStore(backend, () => 2000);
    expect(() => cache.recordSession({ ...record, sourceMessageId: "unrelated" })).toThrow();
    expect(() => cache.recordSession({ ...record, contextProvenance: null })).toThrow();
    expect(() => cache.recordSession({ ...record, channelId: "other" })).toThrow();
    expect(withSessionMessageOrigins(backend)).toBe(withSessionMessageOrigins(backend));
  });
  it.each(["verified", "unbound", "revoked", "expired", "expired_after_read"] as const)("rebuilds only source-bound session-only exchanges from confirmed deliveries: %s", async (scenario) => {
    const { fixture, record } = await setup(); let now = 2000;
    const cache = new SessionMessageOriginStore({ record: vi.fn(), find: vi.fn().mockResolvedValue(null) }, () => now);
    await cache.recordSession(record);
    fixture.sources.set("reply", { event: guardedEvent("reply", 2000, "reply", "bot"), origin: "chat", provenance: null });
    fixture.add(guardedEvent("next", 3000, "continue")); fixture.port.sourceMessageId = "next";
    const read = fixture.port.read;
    fixture.port.read = async (id, signal): Promise<GuardedContextSource | null> => {
      const source = await read(id, signal); if (!source || source.origin !== "chat") return source;
      const origin = await cache.find("guild", "channel", id);
      return origin ? { ...source, sourceMessageId: scenario === "unbound" ? "different-trigger" : origin.sourceMessageId, provenance: origin.contextProvenance ?? null } : null;
    };
    if (scenario === "revoked") fixture.denied.add("source");
    if (scenario === "expired") now += sessionOriginLimits.ttlMs;
    const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 0, burstIds: [] });
    const session: ChatSessionExchange = { user: { content: "SENSITIVE_USER_TEXT", createdAt: 1000, sourceMessageId: "source", channelMemoryMode: "session_only" },
      assistant: { content: "reply", createdAt: 2000, messageIds: ["reply"] }, contextProvenance: null };
    expect(await context.sessions([session])).toHaveLength(scenario === "verified" || scenario === "expired_after_read" ? 1 : 0);
    if (scenario === "verified") { fixture.denied.add("source"); expect(await context.validate()).toBe(false); }
    if (scenario === "expired_after_read") { now += sessionOriginLimits.ttlMs; expect(await context.validate()).toBe(false); }
  });
  it("does not issue ephemeral proof when all context retention is disabled", async () => {
    const { fixture } = await setup(); fixture.port.retention = "none";
    const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 0, burstIds: [] });
    expect(context.provenance("reply")).toBeNull(); expect(context.sessionProvenance("reply")).toBeNull();
  });
  it("retains authorized image references from a reconstructed session even outside selected history", async () => {
    const { fixture, record } = await setup();
    const assets = [{ id: "image", contentType: "image/png", size: 10 }];
    record.contextProvenance = { ...record.contextProvenance!, outputAssetsHash: guardedAssetsHash(assets) };
    const cache = new SessionMessageOriginStore({ record: vi.fn(), find: vi.fn().mockResolvedValue(null) }, () => 2000); await cache.recordSession(record);
    fixture.sources.set("reply", { event: guardedEvent("reply", 2000, "reply", "bot"), assets, origin: "chat", provenance: null });
    const read = fixture.port.read;
    fixture.port.read = async (id, signal): Promise<GuardedContextSource | null> => {
      const source = await read(id, signal); if (!source || source.origin !== "chat") return source;
      const origin = await cache.find("guild", "channel", id);
      return origin ? { ...source, sourceMessageId: origin.sourceMessageId, provenance: origin.contextProvenance ?? null } : null;
    };
    fixture.port.loadAsset = vi.fn().mockResolvedValue("data:image/png;base64,aGVsbG8=");
    fixture.add(guardedEvent("next", 3000, "what was that image?")); fixture.port.sourceMessageId = "next";
    const context = await GuardedConversationContext.open(fixture.port, { count: 0, budget: 0, burstIds: [] });
    expect(await context.sessions([{ user: { content: "SENSITIVE_USER_TEXT", createdAt: 1000, sourceMessageId: "source", channelMemoryMode: "session_only" },
      assistant: { content: "reply", createdAt: 2000, messageIds: ["reply"] }, contextProvenance: null }])).toHaveLength(1);
    expect((await context.images(1)).map((image) => image.sourceMessageId)).toEqual(["reply"]);
    fixture.sources.get("reply")!.assets = [];
    expect(await context.validate()).toBe(false);
  });
});
