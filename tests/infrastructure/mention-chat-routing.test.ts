import type { Message } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { MentionChatBehavior } from "../../src/infrastructure/discord/behaviors/mention-chat-behavior.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { PersonaSource } from "../../src/application/chat/persona-source.js";
import type { MessageOriginStore } from "../../src/application/chat/message-origin-store.js";
import { freshDocument, memoryProvider, guildId } from "../helpers/settings-fixtures.js";

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
