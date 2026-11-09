import { describe, expect, it } from "vitest";
import { promptMessageDetails, promptMessageRecord, promptMessageText } from "../../src/application/chat/prompt-message.js";
import { buildReplyChainOverflowSummaryPrompt } from "../../src/application/chat/reply-chain-overflow-summary.js";
import { buildAttributionVerificationPrompt } from "../../src/application/chat/attribution-verification.js";

const preview = { url: "https://example.com/cats", site: "Example", title: "Ten cats", description: "They dance." };
const message = { content: "look", imageCount: 2, contentTruncated: true, linkPreviews: [preview] };

describe("shared prompt message rendering", () => {
  it("renders text, truncation, images and fenced link previews in one form", () => {
    expect(promptMessageText(message, (text) => `«${text}»`)).toBe(
      "«look» [content truncated; remainder unavailable] [2 images attached] [link preview: «Example — Ten cats — They dance.»]");
    expect(promptMessageText({ content: "plain", imageCount: 0 })).toBe("plain");
    expect(promptMessageDetails(message)).toEqual({ contentTruncated: true, images: 2, linkPreview: "Example — Ten cats — They dance." });
    expect(promptMessageRecord({ ...message, messageId: "m" })).toEqual({ content: "look", messageId: "m", contentTruncated: true, images: 2, linkPreview: "Example — Ten cats — They dance." });
  });
  it("is what the summary and attribution prompts show", () => {
    const note = "[link preview: Example — Ten cats — They dance.]";
    expect(buildReplyChainOverflowSummaryPrompt([{ ...message, authorDisplayName: "Alice" }])).toContain(note);
    expect(buildAttributionVerificationPrompt("draft", [{ ...message, authorId: "1", authorDisplayName: "Alice" }], "now")).toContain(note);
  });
});
