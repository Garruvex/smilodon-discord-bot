import type { Message } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

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
