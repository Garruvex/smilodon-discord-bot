import type { Message } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { ChatTurnSupport } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";

function logger(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}

describe("ChatTurnSupport event projection", () => {
  it("preserves the original addressee through a bot reply joined by another human", () => {
    const support = new ChatTurnSupport(logger());
    const common = { channelId: "channel", attachments: new Map(), channel: { messages: { cache: new Map() } }, createdTimestamp: 1000 };
    const rider = { ...common, id: "question", content: "那引擎要63單套還是63/580", author: { id: "rider", displayName: "Rider" } } as unknown as Message;
    const bot = { ...common, id: "advice", content: "日常騎就63單套", author: { id: "bot", displayName: "Bot", bot: true }, reference: { messageId: "question" } } as unknown as Message;
    const newcomer = { ...common, id: "followup", content: "你也要當跑山猴嗎", author: { id: "new-speaker", displayName: "Bystander" }, reference: { messageId: "advice" } } as unknown as Message;
    const converted = support.toChannelHistoryMessages([rider, bot, newcomer]);
    expect(converted[1]).toMatchObject({ authorId: "bot", replyToAuthorId: "rider", replyToMessageId: "question" });
    expect(converted[2]).toMatchObject({ authorId: "new-speaker", replyToAuthorId: "bot", replyToMessageId: "advice" });
  });
  it("keeps a known immediate reply author even when the target message is not cached", () => {
    const support = new ChatTurnSupport(logger());
    const message = { id: "reply", createdTimestamp: 1000, author: { id: "new-speaker", displayName: "Bystander" },
      content: "followup", attachments: new Map(), reference: { messageId: "advice" },
      mentions: { repliedUser: { id: "bot", displayName: "Bot" } }, channel: { messages: { cache: new Map() } } } as unknown as Message;
    expect(support.toChannelHistoryMessages([message])[0]).toMatchObject({ replyToMessageId: "advice", replyToAuthorId: "bot" });
  });
  it("preserves a reply's known reference ID when its content is unavailable", () => {
    const support = new ChatTurnSupport(logger());
    const message = {
      id: "reply", createdTimestamp: 123, author: { id: "human", displayName: "Human" },
      content: "what about this?", attachments: new Map(), reference: { messageId: "unavailable" },
      channel: { messages: { cache: new Map() } },
    } as unknown as Message;
    expect(support.toChannelHistoryMessages([message])[0]).toMatchObject({
      hasReplyReference: true, replyToMessageId: "unavailable", replyToAuthorId: null,
    });
  });
});
