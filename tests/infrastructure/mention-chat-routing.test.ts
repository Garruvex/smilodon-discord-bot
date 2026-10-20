import type { Message } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { MentionChatBehavior } from "../../src/infrastructure/discord/behaviors/mention-chat-behavior.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { PersonaSource } from "../../src/application/chat/persona-source.js";
import type { MessageOriginStore } from "../../src/application/chat/message-origin-store.js";
import { freshDocument, memoryProvider, guildId } from "../helpers/settings-fixtures.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

function setup(origins: MessageOriginStore | null = null): { behavior: MentionChatBehavior; message: Message; fetch: ReturnType<typeof vi.fn> } {
  const document = freshDocument(); document.chat.participation.messagesPerDecision = 20;
  const fetch = vi.fn(() => Promise.resolve(null));
  const message = { guildId, channelId: "channel", inGuild: () => true, author: { id: "human", bot: false }, mentions: { users: { has: () => false }, repliedUser: null },
    reference: { messageId: "bot-reply", channelId: "channel" }, channel: { messages: { cache: new Map(), fetch } } } as unknown as Message;
  const behavior = new MentionChatBehavior(() => "bot", { ownerUserIds: new Set() } as unknown as ApplicationConfiguration, memoryProvider(document), null,
    {} as PersonaSource, {} as Logger, null, null, null, origins);
  return { behavior, message, fetch };
}
describe("explicit reply routing bypasses optional accumulation", () => {
  it.each(["stale", "missing"] as const)("refreshes a %s member before refusing an authorized direct question", async (cacheState) => {
    const { logger, records } = captureDiagnosticLogger();
    const document = freshDocument(); document.features.chatbot = true;
    document.chat.deniedMessage = "CUSTOM_DENIAL";
    const { message } = setup();
    const member = { roles: { cache: new Map([[document.roles.botAdministrator[0]!, {}]]) } };
    const memberFetch = vi.fn().mockResolvedValue(member);
    const reply = vi.fn().mockResolvedValue(undefined);
    Object.assign(message, { id: "question", content: "<@bot> 大番薯生日要做什麼",
      member: cacheState === "missing" ? null : { roles: { cache: new Map() } }, guild: { members: { fetch: memberFetch } }, reply });
    const behavior = new MentionChatBehavior(() => "bot", { ownerUserIds: new Set() } as unknown as ApplicationConfiguration,
      memoryProvider(document), null, {} as PersonaSource, logger);
    await behavior.execute(message);
    expect(memberFetch).toHaveBeenCalledExactlyOnceWith({ user: "human", force: true });
    expect(records.some((record) => record.reason === "access_denied")).toBe(false);
    expect(records.some((record) => record.reason === "provider_unconfigured")).toBe(true);
    expect(JSON.stringify(reply.mock.calls)).not.toContain("CUSTOM_DENIAL");
  });

  it.each(["missing_chat_role", "restricted_role", "channel_denied", "member_unavailable"] as const)("retains access restrictions and records %s without changing custom copy", async (reason) => {
    const { logger, records } = captureDiagnosticLogger();
    const document = freshDocument(); document.features.chatbot = true;
    document.chat.deniedMessage = "CUSTOM_DENIAL";
    const roles = new Map([[document.roles.botAdministrator[0]!, {}]]);
    if (reason === "missing_chat_role") roles.clear();
    if (reason === "restricted_role") { document.roles.restricted = ["restricted"]; roles.set("restricted", {}); }
    if (reason === "channel_denied") document.channels.chatbot = ["elsewhere"];
    const { message } = setup();
    const memberFetch = reason === "member_unavailable" ? vi.fn().mockRejectedValue(new Error("Discord unavailable")) : vi.fn().mockResolvedValue({ roles: { cache: roles } });
    const reply = vi.fn().mockResolvedValue(undefined);
    Object.assign(message, { id: "question", member: null, guild: { members: { fetch: memberFetch } }, reply });
    const behavior = new MentionChatBehavior(() => "bot", { ownerUserIds: new Set() } as unknown as ApplicationConfiguration,
      memoryProvider(document), null, {} as PersonaSource, logger);
    await behavior.execute(message);
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "access_denied", accessReason: reason,
      memberRefresh: reason === "member_unavailable" ? "unavailable" : "current" })]));
    if (reason === "member_unavailable") expect(reply).not.toHaveBeenCalled();
    else expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: "CUSTOM_DENIAL" }));
  });
  it("explains unknown reply targets and disabled direct chat without reading history", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const document = freshDocument(); document.features.chatbot = false;
    const { message, fetch } = setup();
    const behavior = new MentionChatBehavior(() => "bot", { ownerUserIds: new Set() } as unknown as ApplicationConfiguration,
      memoryProvider(document), null, {} as PersonaSource, logger);
    expect(await behavior.matches(message)).toBe(false);
    await behavior.execute(message);
    expect(records.map((record) => record.reason)).toEqual(["unresolved_reply_origin", "chat_disabled"]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("routes a reply to the bot through the direct path even with reply pings disabled and a minimum of 20", async () => {
    const { behavior, message, fetch } = setup(); Object.assign(message.mentions, { repliedUser: { id: "bot" } });
    expect(await behavior.matches(message)).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it("resolves uncached own replies from persisted chat origins without fetching human conversation history", async () => {
    const find = vi.fn(() => Promise.resolve({ guildId, channelId: "channel", messageId: "bot-reply", origin: "chat" as const, sourceMessageId: "human", createdAt: 1000 }));
    const { behavior, message, fetch } = setup({ find, record: () => Promise.resolve() });
    expect(await behavior.matches(message)).toBe(true); expect(find).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });
  it("abstains on unknown targets and other recipients, and does not fetch across channels", async () => {
    const { behavior, message, fetch } = setup();
    expect(await behavior.matches(message)).toBe(false);
    Object.assign(message.mentions, { repliedUser: { id: "other-human" } }); expect(await behavior.matches(message)).toBe(false);
    Object.assign(message.mentions, { repliedUser: { id: "bot" } }); Object.assign(message.reference!, { channelId: "other-channel" });
    expect(await behavior.matches(message)).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
});
