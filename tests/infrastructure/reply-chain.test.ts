import { describe, expect, it, vi } from "vitest";
import { ChatTurnSupport } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";

describe("Reply author projection", () => {
  it("preserves the author of the message each history entry replies to", () => {
    const cache = new Map<string, unknown>();
    const channel = { messages: { cache } };
    const fluffy = {
      id: "fluffy-message",
      author: { id: "fluffy", displayName: "Fluffy" },
      member: { displayName: "Fluffy" },
      content: "Is it not very big?",
      attachments: new Map(),
      channel,
    };
    const botReply = {
      id: "bot-reply",
      author: { id: "bot", displayName: "Pinecone" },
      member: { displayName: "Pinecone" },
      content: "Punctuation, help me.",
      attachments: new Map(),
      reference: { messageId: "fluffy-message" },
      channel,
    };
    cache.set(fluffy.id, fluffy);
    cache.set(botReply.id, botReply);

    const history = new ChatTurnSupport({ warn: vi.fn() } as never).toChannelHistoryMessages([fluffy, botReply] as never);

    expect(history[1]).toMatchObject({
      authorId: "bot",
      replyToAuthorId: "fluffy",
      replyToAuthorDisplayName: "Fluffy",
    });
  });

});
