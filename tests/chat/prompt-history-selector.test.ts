import { describe, expect, it } from "vitest";

import {
  promptHistoryLimits,
  RecentPromptHistorySelector,
} from "../../src/application/chat/prompt-history-selector.js";
import type { ChatSessionExchange } from "../../src/application/chat/chat-state-store.js";

function exchange(index: number, content = `message-${index}`): ChatSessionExchange {
  return {
    user: { content, createdAt: index },
    assistant: { content: `reply-${index}`, createdAt: index },
  };
}

describe("RecentPromptHistorySelector", () => {
  it("selects only the newest complete exchanges", () => {
    const selected = new RecentPromptHistorySelector().select(
      Array.from({ length: 7 }, (_, index) => exchange(index)),
    );

    expect(selected).toHaveLength(promptHistoryLimits.maxExchanges * 2);
    expect(selected[0]).toEqual({ role: "user", content: "message-3" });
    expect(selected.at(-1)).toEqual({ role: "assistant", content: "reply-6" });
  });

  it("drops whole oldest exchanges to stay within the character budget", () => {
    const selected = new RecentPromptHistorySelector().select([
      exchange(1, "a".repeat(2_500)),
      exchange(2, "b".repeat(2_500)),
      exchange(3, "c".repeat(2_500)),
    ]);

    expect(JSON.stringify(selected).length).toBeLessThanOrEqual(promptHistoryLimits.maxSerializedChars);
    expect(selected.map((message) => message.content)).not.toContain("a".repeat(2_500));
    expect(selected).toHaveLength(4);
  });
});
