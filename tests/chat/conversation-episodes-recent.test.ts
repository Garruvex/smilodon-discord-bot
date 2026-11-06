import { describe, expect, it } from "vitest";
import { ConversationEpisodes } from "../../src/application/chat/conversation-episodes.js";
import type { ChannelHistoryMessage } from "../../src/application/chat/chat-provider.js";

const event = (messageId: string, timestampMs: number, authorId: string, replyToAuthorId: string | null = null): ChannelHistoryMessage =>
  ({ messageId, timestampMs, authorId, authorDisplayName: authorId, content: "text", imageCount: 0, replyToAuthorId });

describe("recent conversation routing", () => {
  it("counts recent messages instead of elapsed time", () => {
    const episodes = new ConversationEpisodes();
    episodes.observe("key", event("answer", 1_000, "bot", "alice"), 1_000);
    // Five minutes later, past the old two-minute window, the answer is still recent.
    episodes.observe("key", event("now", 301_000, "alice"), 301_000);
    expect(episodes.hasRecentConversation("key", "alice", "bot", 3)).toBe(true);
    expect(episodes.hasRecentConversation("key", "bob", "bot", 3)).toBe(false);
    for (const id of ["a", "b", "c"]) episodes.observe("key", event(id, 302_000, "bob"), 302_000);
    expect(episodes.hasRecentConversation("key", "alice", "bot", 3)).toBe(false);
  });
});
