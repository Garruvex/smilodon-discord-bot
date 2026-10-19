import type { Message } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

import { ChatTurnSupport } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";

function logger(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}

function fakeMessage(id: string, fetch: ReturnType<typeof vi.fn>): Message {
  return {
    id,
    channel: { messages: { fetch } },
    client: { user: { id: "bot-1" } },
  } as unknown as Message;
}

describe("ChatTurnSupport.resolveChannelHistory", () => {
  it("distinguishes inaccessible history retrieval from an empty successful fetch", async () => {
    const { logger, records } = captureDiagnosticLogger();
    const support = new ChatTurnSupport(logger);
    await support.resolveChannelHistory(fakeMessage("first", vi.fn(() => Promise.reject(new Error("SECRET_ERROR")))) , 8, new Set());
    await support.resolveChannelHistory(fakeMessage("second", vi.fn(() => Promise.resolve(new Map()))), 8, new Set());
    expect(records.map((record) => ({ status: record.status, selected: record.selected }))).toEqual([
      { status: "fetch_failed", selected: 0 }, { status: "complete", selected: 0 },
    ]);
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });
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
  it("defaults to fetching the channel before the triggering message (a live mention/ambient turn)", async () => {
    const support = new ChatTurnSupport(logger());
    const fetch = vi.fn(() => Promise.resolve(new Map()));
    const message = fakeMessage("trigger-1", fetch);

    await support.resolveChannelHistory(message, 8, new Set());

    expect(fetch).toHaveBeenCalledExactlyOnceWith({ limit: 32, before: "trigger-1" });
  });

  it("fetches the most recent channel activity, with no cutoff, when before is passed as null", async () => {
    const support = new ChatTurnSupport(logger());
    const fetch = vi.fn(() => Promise.resolve(new Map()));
    const message = fakeMessage("old-reply-1", fetch);

    await support.resolveChannelHistory(message, 8, new Set(), null);

    expect(fetch).toHaveBeenCalledExactlyOnceWith({ limit: 32 });
  });
});
