import { describe, expect, it } from "vitest";

import { boundSessionExchanges, type ChatSessionExchange } from "../../src/application/chat/chat-state-store.js";

function exchange(index: number, contentLength = 10): ChatSessionExchange {
  return {
    user: { content: `u${index}-${"x".repeat(contentLength)}`, createdAt: index },
    assistant: { content: `a${index}-${"x".repeat(contentLength)}`, createdAt: index },
  };
}

describe("boundSessionExchanges", () => {
  it("reports no drops when under both caps", () => {
    const exchanges = [exchange(0), exchange(1)];
    const { kept, dropped } = boundSessionExchanges(exchanges);
    expect(kept).toEqual(exchanges);
    expect(dropped).toEqual([]);
  });

  it("reports the count-cap-evicted exchanges as dropped, oldest first", () => {
    const exchanges = Array.from({ length: 10 }, (_, index) => exchange(index));
    const { kept, dropped } = boundSessionExchanges(exchanges);
    expect(kept).toHaveLength(8);
    expect(kept).toEqual(exchanges.slice(-8));
    expect(dropped).toEqual(exchanges.slice(0, 2));
  });

  it("reports the char-budget-evicted exchanges as dropped, oldest first", () => {
    const exchanges = Array.from({ length: 8 }, (_, index) => exchange(index, 2_000));
    const { kept, dropped } = boundSessionExchanges(exchanges);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(16_000);
    expect(kept.length).toBeLessThan(8);
    expect(dropped.length).toBeGreaterThan(0);
    // Combined, kept+dropped must account for every input exchange exactly
    // once, oldest-dropped-first, so no exchange is silently lost.
    expect([...dropped, ...kept]).toEqual(exchanges);
  });
});
