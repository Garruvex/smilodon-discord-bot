import { EventEmitter } from "node:events";
import { Collection, type GuildMember, type Message } from "discord.js";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { GuardedConversationContext, type GuardedContextPort } from "../../src/application/chat/guarded-conversation-context.js";
import { ChatTurnSupport } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";
import type { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";
import { withSessionMessageOrigins } from "../../src/application/chat/session-message-origins.js";

type MessageFetch = (options: { message?: string; before?: string; limit?: number }) => Promise<Message | Map<string, Message> | null>;
afterEach(() => vi.useRealTimers());

async function fixture(retention: "durable" | "session" = "durable", snapshots = false): Promise<{
  lease: GuardedConversationContext; messages: Map<string, Message>;
  fetch: Mock<MessageFetch>; memberFetch: ReturnType<typeof vi.fn>; denied: Set<string>;
  port: GuardedContextPort;
  client: EventEmitter; forgotten: Set<string>;
  support: ChatTurnSupport; backendRecord: ReturnType<typeof vi.fn>;
  records: Record<string, unknown>[];
}> {
  const messages = new Map<string, Message>(); const denied = new Set<string>(); const forgotten = new Set<string>();
  const client = Object.assign(new EventEmitter(), { user: { id: "bot" }, isReady: (): boolean => true });
  const member = { displayName: "Alice", roles: { cache: new Map() } } as unknown as GuildMember;
  const memberFetch = vi.fn().mockResolvedValue(member);
  const fetch = vi.fn<MessageFetch>((options) => {
    if (options.message) return Promise.resolve(messages.get(options.message) ?? null);
    return Promise.resolve(new Map([...messages].filter(([id]) => !options.before || BigInt(id) < BigInt(options.before))
      .sort(([a], [b]) => Number(BigInt(b) - BigInt(a))).slice(0, options.limit)));
  });
  const channel = { messages: { fetch } };
  for (let id = 1; id <= 41; id++) {
    messages.set(String(id), { id: String(id), guildId: "guild", channelId: "channel", createdTimestamp: id,
      author: { id: "alice", bot: false, username: "Alice", displayName: "Alice" }, member,
      guild: { members: { fetch: memberFetch } }, channel, client: snapshots ? client : { user: { id: "bot" } }, content: `text ${id}`,
      attachments: new Map(), inGuild: () => true } as unknown as Message);
  }
  const eligibility = {
    canUseContextChannel: () => Promise.resolve(true), contextPolicyVersion: () => `policy:${[...denied].join(",")}`, botCanReadChannel: () => true, hasContextRoleExclusions: () => true,
    sourceForgotten: (message: Message) => Promise.resolve(forgotten.has(message.id)),
    sourcesForgotten: (batch: readonly Message[]) => Promise.resolve(batch.map((message) => forgotten.has(message.id))), canPersistContext: () => retention === "durable", canShareContext: () => retention === "durable", contextRetention: () => retention,
    check: () => Promise.resolve({ eligible: true, reason: "allowed" }), checkGuardedActor: () => Promise.resolve(true),
    canReadHistory: () => Promise.resolve(true),
    checkGuardedSource: (message: Message) => Promise.resolve({ eligible: !denied.has(message.id), reason: "passive_access_denied" }),
  } as unknown as SocialChatEligibility;
  const { logger, records } = captureDiagnosticLogger();
  const backendRecord = vi.fn();
  const support = new ChatTurnSupport(logger, eligibility, withSessionMessageOrigins({ record: backendRecord, find: vi.fn().mockResolvedValue(null) }));
  const port = support.createContextPort(messages.get("41")!);
  const lease = await GuardedConversationContext.open(port, { count: 40, budget: 24000, burstIds: [] });
  fetch.mockClear(); memberFetch.mockClear();
  return { lease, messages, fetch, memberFetch, denied, port, support, backendRecord, client, forgotten, records };
}

describe("Fallback guarded validation without Discord event snapshots", () => {
  it("continues a session-only exchange through actual delivery and fresh Discord source reads without a durable origin write", async () => {
    const { support, lease, messages, fetch, backendRecord } = await fixture("session");
    const current = messages.get("41")!;
    const sent = { ...current, id: "42", createdTimestamp: 42, content: "SESSION_ONLY_REPLY", author: { id: "bot", bot: true, username: "Bot" }, attachments: new Collection() } as unknown as Message;
    messages.set("42", sent);
    await support.deliverChatResponse({ sender: { first: () => Promise.resolve(sent), rest: vi.fn() }, text: sent.content, images: [], sources: [],
      emptyFallbackContent: "empty", maxImageAggregateBytes: 1024, contextLease: lease, sourceMessage: current });
    expect(backendRecord).not.toHaveBeenCalled();
    const nextMessage = { ...current, id: "43", createdTimestamp: 43, content: "continue" } as Message; messages.set("43", nextMessage); fetch.mockClear();
    const next = await GuardedConversationContext.open(support.createContextPort(nextMessage), { count: 0, budget: 0, burstIds: [] });
    expect(await next.sessions([{ user: { content: "text 41", sourceMessageId: "41", createdAt: 41, channelMemoryMode: "session_only" },
      assistant: { content: sent.content, messageIds: ["42"], createdAt: 42 }, contextProvenance: null }])).toHaveLength(1);
    expect(await next.validate()).toBe(true); expect(fetch.mock.calls.length).toBeLessThanOrEqual(5);
  });
  it("batches distant dependency groups with simulated REST delay and multiple authors", async () => {
    const { port, fetch, messages, memberFetch } = await fixture(); vi.useFakeTimers();
    const template = messages.get("41")!;
    for (let id = 1001; id <= 1100; id++) messages.set(String(id), { ...template, id: String(id),
      author: { ...template.author, id: `author-${id % 3}` } } as Message);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (options) => { await new Promise((resolve) => setTimeout(resolve, 600)); return original(options); });
    const signal = new AbortController().signal;
    const ids = ["1100", "1099", "1098", "1097", "40", "39", "38", "37"];
    const pending = port.prepareValidation!(ids, signal);
    await vi.advanceTimersByTimeAsync(1200); await pending;
    for (const id of ids) expect(await port.read(id, signal)).not.toBeNull();
    expect(fetch.mock.calls.map(([options]) => options.before)).toEqual(["1101", "41"]);
    expect(memberFetch).toHaveBeenCalledTimes(4);
  });

  it("uses individual reads for a tiny dependency set", async () => {
    const { port, fetch } = await fixture(); const signal = new AbortController().signal;
    await port.prepareValidation!(["1", "2"], signal); expect(fetch).not.toHaveBeenCalled();
    expect(await port.read("1", signal)).not.toBeNull(); expect(await port.read("2", signal)).not.toBeNull();
    expect(fetch.mock.calls.map(([options]) => options.message)).toEqual(["1", "2"]);
  });

  it("caps batch requests at three pages for widely scattered dependencies", async () => {
    const { port, fetch, messages } = await fixture(); const template = messages.get("41")!;
    const ids: string[] = [];
    for (let group = 1; group <= 4; group++) {
      for (let offset = 1; offset <= 100; offset++) { const id = String(group * 1000 + offset); messages.set(id, { ...template, id } as Message); if (offset > 96) ids.push(id); }
    }
    await port.prepareValidation!(ids, new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("validates 40 history messages plus the current event with one fresh page per phase", async () => {
    const { lease, fetch, memberFetch } = await fixture();
    expect(lease.history).toHaveLength(40);
    expect(await lease.validate()).toBe(true);
    expect(fetch).toHaveBeenCalledExactlyOnceWith({ limit: 100, before: "42", cache: false });
    expect(memberFetch).toHaveBeenCalledExactlyOnceWith({ user: "alice", force: true });
    expect(await lease.validate()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(memberFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["edit", "delete", "revoke", "foreign_scope"] as const)("still invalidates %s with freshly fetched transport data", async (change) => {
    const { lease, messages, fetch, denied } = await fixture();
    if (change === "edit") Object.assign(messages.get("10")!, { content: "edited" });
    if (change === "delete") messages.delete("10");
    if (change === "revoke") denied.add("10");
    if (change === "foreign_scope") Object.assign(messages.get("10")!, { channelId: "private" });
    expect(await lease.validate()).toBe(false);
    expect(lease.provenance("answer")).toBeNull();
    if (change === "delete" || change === "foreign_scope") expect(fetch).toHaveBeenCalledWith({ message: "10", force: true });
  });

  it("falls back to an individual fresh read for dependencies outside the returned page", async () => {
    const { lease, fetch, messages } = await fixture();
    fetch.mockImplementation((options: { message?: string }) => options.message
      ? Promise.resolve(messages.get(options.message) ?? null)
      : Promise.resolve(new Map([...messages].filter(([id]) => id !== "1"))));
    expect(await lease.validate()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith({ message: "1", force: true });
  });

  it("fails closed on a failed fresh page instead of validating against an old cache", async () => {
    const { lease, fetch } = await fixture(); fetch.mockRejectedValue(new Error("Discord unavailable"));
    expect(await lease.validate()).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
});


describe("Discord one-pass context snapshots", () => {
  it("reports the event that invalidates a trigger without exposing message content", async () => {
    const { support, messages, client, records, denied } = await fixture("durable", true);
    const eligible = support.createEligibilityCheck(messages.get("41")!);
    expect(await eligible()).toBe(true);
    messages.get("41")!.content = "updated question";
    client.emit("messageUpdate", {}, messages.get("41"));
    expect(await eligible()).toBe(true);
    // An actual policy denial, not the role event itself, invalidates access.
    denied.add("41");
    client.emit("roleUpdate", {}, { guild: { id: "guild" } });
    expect(await eligible()).toBe(false);
    expect(await eligible()).toBe(false);
    expect(records.filter((record) => record.event === "chat.snapshot.invalidated")).toEqual([
      expect.objectContaining({ gate: "trigger", change: "role_update" }),
    ]);
    expect(records).toContainEqual(expect.objectContaining({ event: "chat.guard.rejected", reason: "discord_revision_changed" }));
    expect(JSON.stringify(records)).not.toContain("text 41");
  });
  it("reuses 40 filtered history messages across 80 nested checks without REST reads or membership scans", async () => {
    const { lease, fetch, memberFetch } = await fixture("durable", true);
    expect(lease.history).toHaveLength(40);
    const reads = lease.report.sourceReads;
    for (let index = 0; index < 80; index++) expect(await lease.validate()).toBe(true);
    expect(await lease.validate("effect")).toBe(true);
    expect(lease.report.sourceReads).toBe(reads);
    expect(fetch).not.toHaveBeenCalled(); expect(memberFetch).not.toHaveBeenCalled();
  });
  it.each(["messageUpdate", "messageDelete", "messageDeleteBulk", "shardDisconnect", "shardReconnecting", "shardResume"])(
    "invalidates a snapshot on %s without fetching the entire channel again", async (event) => {
      const { lease, client, fetch, messages, records } = await fixture("durable", true);
      const guild = { id: "guild" }; const message = messages.get("10")!;
      if (event === "messageUpdate") client.emit(event, { ...message, content: "before edit" }, message);
      else if (event === "messageDelete") client.emit(event, message);
      else if (event === "messageDeleteBulk") client.emit(event, new Map([[message.id, message]]), { id: "channel" });
      else if (event === "guildMemberUpdate" || event === "roleUpdate") client.emit(event, {}, { guild });
      else if (event === "channelUpdate" || event === "threadUpdate") client.emit(event, {}, { guildId: "guild" });
      else client.emit(event);
      expect(await lease.validate()).toBe(false); expect(fetch).not.toHaveBeenCalled();
      expect(records).toContainEqual(expect.objectContaining({ event: "chat.snapshot.invalidated", gate: "context",
        change: event.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`) }));
      expect(lease.provenance("answer")).toBeNull();
    });
  it("does not invalidate for a normal new message or an edit in an unrelated channel", async () => {
    const { lease, client, fetch, messages } = await fixture("durable", true);
    client.emit("messageCreate", messages.get("41"));
    client.emit("messageUpdate", messages.get("41"), messages.get("41"));
    client.emit("messageUpdate", {}, { channelId: "other-channel" });
    client.emit("messageUpdate", {}, { channelId: "channel", id: "unrelated-utility-panel" });
    expect(await lease.validate()).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["guildMemberUpdate", "roleUpdate", "channelUpdate", "threadUpdate"])("rechecks policy without cancelling on harmless %s", async (event) => {
    const { lease, client, fetch } = await fixture("durable", true);
    client.emit(event, {}, { guild: { id: "guild" }, guildId: "guild" });
    expect(await lease.validate("effect")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks shared persistence forget tombstones at an effect boundary without a full REST scan", async () => {
    const { lease, forgotten, fetch } = await fixture("durable", true);
    forgotten.add("10");
    expect(await lease.validate("effect")).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
  it("invalidates when configured opt-out policy changes during a model call", async () => {
    const { lease, denied } = await fixture("durable", true); denied.add("10");
    expect(await lease.validate()).toBe(false);
  });
  it("installs a single listener set for multiple turns", async () => {
    const { support, messages, client } = await fixture("durable", true);
    for (let index = 0; index < 20; index++) support.createContextPort(messages.get("41")!);
    expect(client.listenerCount("messageUpdate")).toBe(1); expect(client.listenerCount("guildMemberUpdate")).toBe(1);
  });
});
