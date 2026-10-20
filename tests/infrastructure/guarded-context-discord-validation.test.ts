import type { GuildMember, Message } from "discord.js";
import { describe, expect, it, vi, type Mock } from "vitest";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { ChatTurnSupport } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";
import type { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

type MessageFetch = (options: { message?: string; before?: string; limit?: number }) => Promise<Message | Map<string, Message> | null>;

async function fixture(): Promise<{
  lease: GuardedConversationContext; messages: Map<string, Message>;
  fetch: Mock<MessageFetch>; memberFetch: ReturnType<typeof vi.fn>; denied: Set<string>;
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
    contextPolicyVersion: () => "current-policy", canPersistContext: () => true,
    canReadHistory: () => Promise.resolve(true),
    checkGuardedSource: (message: Message) => Promise.resolve({ eligible: !denied.has(message.id), reason: "passive_access_denied" }),
  } as unknown as SocialChatEligibility;
  const { logger } = captureDiagnosticLogger();
  const port = new ChatTurnSupport(logger, eligibility).createContextPort(messages.get("41")!);
  const lease = await GuardedConversationContext.open(port, { count: 40, budget: 24000, burstIds: [] });
  fetch.mockClear(); memberFetch.mockClear();
  return { lease, messages, fetch, memberFetch, denied };
}

describe("Discord guarded validation transport", () => {
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
