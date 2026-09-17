import { describe, expect, it } from "vitest";

import { getQuoteText, hasQuotableContent } from "../../src/infrastructure/discord/commands/common/quote-card-renderer.js";

import type { Message } from "discord.js";

function fakeMessage(overrides: {
  content?: string;
  stickers?: unknown[];
}): Message {
  const stickers = overrides.stickers ?? [];
  return {
    content: overrides.content ?? "",
    embeds: [],
    mentions: { users: new Map(), channels: new Map() },
    stickers: {
      size: stickers.length,
      find: (predicate: (s: unknown) => boolean) => stickers.find(predicate),
      first: () => stickers[0],
    },
  } as unknown as Message;
}

describe("getQuoteText", () => {
  it("keeps unicode emoji as-is", () => {
    const message = fakeMessage({ content: "nice one 🔥🔥" });
    expect(getQuoteText(message)).toBe("nice one 🔥🔥");
  });

  it("falls back custom emoji tags to :name: form", () => {
    const message = fakeMessage({ content: "poggers <a:vibing:123456789012345678> yeah" });
    expect(getQuoteText(message)).toBe("poggers :vibing: yeah");
  });

  it("strips markdown while leaving emoji untouched", () => {
    const message = fakeMessage({ content: "**bold** _italic_ 🎉" });
    expect(getQuoteText(message)).toBe("bold italic 🎉");
  });

  it("truncates long text and appends an ellipsis", () => {
    const message = fakeMessage({ content: "a".repeat(400) });
    const text = getQuoteText(message);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThan(400);
  });

  it("does not truncate a message full of custom emoji far short of its unit length", () => {
    const emoji = "<a:vibing:123456789012345678>";
    const message = fakeMessage({ content: emoji.repeat(50) });
    const text = getQuoteText(message);
    expect(text).not.toContain("…");
  });
});

describe("hasQuotableContent", () => {
  it("is false for an empty message with no stickers", () => {
    expect(hasQuotableContent(fakeMessage({}))).toBe(false);
  });

  it("is true for a sticker-only message with no text", () => {
    expect(hasQuotableContent(fakeMessage({ stickers: [{ id: "1", name: "cool" }] }))).toBe(true);
  });

  it("is true when there is text", () => {
    expect(hasQuotableContent(fakeMessage({ content: "hi" }))).toBe(true);
  });
});
