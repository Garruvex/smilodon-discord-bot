import type { GuildMember, Message } from "discord.js";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { GuardedConversationContext, type GuardedContextPort } from "../../src/application/chat/guarded-conversation-context.js";
import { ChatTurnSupport } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";
import type { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

type MessageFetch = (options: { message?: string; before?: string; limit?: number }) => Promise<Message | Map<string, Message> | null>;
afterEach(() => vi.useRealTimers());

async function fixture(): Promise<{
  lease: GuardedConversationContext; messages: Map<string, Message>;
  fetch: Mock<MessageFetch>; memberFetch: ReturnType<typeof vi.fn>; denied: Set<string>;
  port: GuardedContextPort;
}> {
  const messages = new Map<string, Message>(); const denied = new Set<string>();
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
      guild: { members: { fetch: memberFetch } }, channel, client: { user: { id: "bot" } }, content: `text ${id}`,
      attachments: new Map(), inGuild: () => true } as unknown as Message);
  }
  const eligibility = {
    contextPolicyVersion: () => "current-policy", canPersistContext: () => true, canShareContext: () => true,
    canReadHistory: () => Promise.resolve(true),
    checkGuardedSource: (message: Message) => Promise.resolve({ eligible: !denied.has(message.id), reason: "passive_access_denied" }),
  } as unknown as SocialChatEligibility;
  const { logger } = captureDiagnosticLogger();
  const port = new ChatTurnSupport(logger, eligibility).createContextPort(messages.get("41")!);
  const lease = await GuardedConversationContext.open(port, { count: 40, budget: 24000, burstIds: [] });
  fetch.mockClear(); memberFetch.mockClear();
  return { lease, messages, fetch, memberFetch, denied, port };
}

describe("Discord guarded validation transport", () => {
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
