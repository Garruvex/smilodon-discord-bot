import { describe, expect, it } from "vitest";

import {
  buildSourceBlock,
  chatDeliveryLimits,
  discordMessageCharLimit,
  planChatDelivery,
} from "../../src/application/chat/chat-message-chunker.js";
import type { ChatSource } from "../../src/application/chat/chat-provider.js";

describe("planChatDelivery", () => {
  it("keeps a reply at exactly the Discord char limit as a single chunk", () => {
    const text = "a".repeat(1_999);
    const plan = planChatDelivery(text, []);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    expect(plan.chunks).toEqual([text]);
  });

  it("keeps a reply at exactly 2,000 chars as a single chunk", () => {
    const text = "a".repeat(2_000);
    const plan = planChatDelivery(text, []);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]).toHaveLength(2_000);
  });

  it("splits a reply at 2,001 chars into two chunks, each within the Discord limit", () => {
    const text = "a".repeat(2_001);
    const plan = planChatDelivery(text, []);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    expect(plan.chunks.length).toBeGreaterThan(1);
    for (const chunk of plan.chunks) expect(chunk.length).toBeLessThanOrEqual(discordMessageCharLimit);
    expect(plan.chunks.join("")).toBe(text);
  });

  it("splits a 4,000-char reply into chunks that reassemble to the original text", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(35)}`.trim());
    const text = paragraphs.join("\n\n");
    const plan = planChatDelivery(text, []);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    for (const chunk of plan.chunks) expect(chunk.length).toBeLessThanOrEqual(discordMessageCharLimit);
    expect(plan.chunks.join("\n")).toBe(text);
  });

  it("falls back to a .txt attachment once the reply needs more than the default chunk budget", () => {
    const text = "word ".repeat(2_000).trim(); // ~10,000 chars, well past 8,000/4 chunks
    const plan = planChatDelivery(text, []);

    expect(plan.mode).toBe("attachment");
    if (plan.mode !== "attachment") throw new Error("unreachable");
    // Nothing is lost — the complete text is in the attachment, untruncated.
    expect(plan.attachmentText).toBe(text);
    expect(plan.note.length).toBeLessThanOrEqual(discordMessageCharLimit);
  });

  it("stays within the default chunk budget right at its boundary (8,000 chars / 4 chunks)", () => {
    const text = "a".repeat(chatDeliveryLimits.maxTotalChars);
    const plan = planChatDelivery(text, []);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    expect(plan.chunks.length).toBeLessThanOrEqual(chatDeliveryLimits.maxChunks);
  });

  it("falls back to attachment mode just past the default chunk budget (8,001 chars)", () => {
    const text = "a".repeat(chatDeliveryLimits.maxTotalChars + 1);
    const plan = planChatDelivery(text, []);

    expect(plan.mode).toBe("attachment");
  });

  it("never splits a surrogate-pair emoji sequence across a chunk boundary", () => {
    // A run of 4-byte-UTF-16 emoji long enough to force a hard split.
    const emoji = "😀".repeat(1_500);
    const plan = planChatDelivery(emoji, []);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    for (const chunk of plan.chunks) {
      // A torn surrogate pair produces an unpaired lone surrogate somewhere
      // in the string — this regex matches either a high surrogate not
      // followed by a low one, or a low surrogate not preceded by a high one.
      expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
    expect(plan.chunks.join("")).toBe(emoji);
  });

  it("keeps a fenced code block intact within one chunk when it fits", () => {
    const text = "Here's some code:\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nHope that helps!";
    const plan = planChatDelivery(text, []);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    expect(plan.chunks).toEqual([text]);
  });

  it("closes and reopens a fenced code block that has to split across chunks", () => {
    const codeLines = Array.from({ length: 400 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `\`\`\`js\n${codeLines}\n\`\`\``;
    const plan = planChatDelivery(text, []);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    expect(plan.chunks.length).toBeGreaterThan(1);
    // Every chunk is independently well-formed Markdown: an even number of
    // fence delimiter lines (each chunk either has no fence or a balanced
    // open+close pair).
    for (const chunk of plan.chunks) {
      const fenceLines = chunk.split("\n").filter((line) => /^```/.test(line.trim()));
      expect(fenceLines.length % 2).toBe(0);
    }
  });

  it("preserves links and list markup on their own lines without splitting mid-line", () => {
    const text = [
      "Here's what I found:",
      "",
      "- [Example](https://example.com/a)",
      "- [Another](https://example.com/b)",
      "- Plain list item",
    ].join("\n");
    const plan = planChatDelivery(text, []);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    expect(plan.chunks.join("\n")).toBe(text);
  });

  it("appends sources to the final chunk when they fit", () => {
    const sources: ChatSource[] = [{ title: "Example", url: "https://example.com" }];
    const plan = planChatDelivery("Short reply.", sources);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]).toContain("Short reply.");
    expect(plan.chunks[0]).toContain(buildSourceBlock(sources).trim());
  });

  it("puts sources in their own chunk when they don't fit in the last one", () => {
    const sources: ChatSource[] = Array.from({ length: 30 }, (_, i) => ({
      title: `Source number ${i}`,
      url: `https://example.com/very/long/path/segment/${i}`,
    }));
    const nearLimitText = "a".repeat(1_950);
    const plan = planChatDelivery(nearLimitText, sources);

    expect(plan.mode).toBe("chunks");
    if (plan.mode !== "chunks") throw new Error("unreachable");
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks[0]).toBe(nearLimitText);
    expect(plan.chunks.slice(1).join("\n")).toContain("Sources:");
    expect(plan.chunks.at(-1)).toContain(`Source number ${sources.length - 1}`);
  });
});
