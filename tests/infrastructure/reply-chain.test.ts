import { describe, expect, it, vi } from "vitest";

import { chatMemoryLimits } from "../../src/application/chat/chat-memory-policy.js";
import { ChatTurnSupport } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";

interface FakeMessage {
  id: string;
  content: string;
  reference?: { messageId: string } | undefined;
  channel: { messages: { fetch: (id: string) => Promise<FakeMessage | null> } };
}

function chainOf(
  length: number,
  contentFor: (index: number) => string = (index) => `hop-${index}`,
  brokenIds: ReadonlySet<string> = new Set(),
): FakeMessage[] {
  const byId = new Map<string, FakeMessage>();
  const fetch = (id: string): Promise<FakeMessage | null> =>
    brokenIds.has(id) ? Promise.reject(new Error("deleted or inaccessible")) : Promise.resolve(byId.get(id) ?? null);
  const channel = { messages: { fetch } };
  const messages: FakeMessage[] = [];
  for (let index = 0; index < length; index += 1) {
    const message: FakeMessage = {
      id: `m${index}`,
      content: contentFor(index),
      channel,
      reference: index > 0 ? { messageId: `m${index - 1}` } : undefined,
    };
    byId.set(message.id, message);
    messages.push(message);
  }
  return messages;
}

function turnSupport(): ChatTurnSupport {
  return new ChatTurnSupport({ warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never);
}

function resolveReplyChain(support: ChatTurnSupport, message: FakeMessage): Promise<FakeMessage[]> {
  return support.resolveReplyChain(message as never) as unknown as Promise<FakeMessage[]>;
}

interface FakeChannelMessage {
  id: string;
  content: string;
}

// Discord's channel.messages.fetch({ limit, before }) returns a
// Collection (Map-like) ordered newest-first — this fake mirrors that.
function fakeChannelMessage(
  historyNewestFirst: readonly FakeChannelMessage[],
  fetchError = false,
): FakeMessage {
  const fetch = vi.fn(() => {
    if (fetchError) return Promise.reject(new Error("channel unavailable"));
    const map = new Map(historyNewestFirst.map((entry) => [entry.id, entry]));
    return Promise.resolve(map);
  });
  return {
    id: "current",
    content: "current message",
    channel: { messages: { fetch: fetch as never } },
  };
}

function resolveChannelHistory(
  support: ChatTurnSupport,
  message: FakeMessage,
  limit: number,
  excludeIds: ReadonlySet<string> = new Set(),
): Promise<FakeChannelMessage[]> {
  return support.resolveChannelHistory(message as never, limit, excludeIds);
}

describe("ChatTurnSupport reply chain resolution", () => {
  it("stops at the depth cap, returning ancestors oldest-first", async () => {
    const messages = chainOf(chatMemoryLimits.maxReplyChainDepth + 5);
    const current = messages.at(-1)!;
    const chain = await resolveReplyChain(turnSupport(), current);
    expect(chain).toHaveLength(chatMemoryLimits.maxReplyChainDepth);
    // Oldest-first: the last entry should be the immediate parent of `current`.
    expect(chain.at(-1)?.id).toBe(messages.at(-2)?.id);
  });

  it("stops early once the char budget is exhausted, even under the depth cap", async () => {
    const bigContent = "x".repeat(chatMemoryLimits.maxUserMessageChars);
    const messages = chainOf(chatMemoryLimits.maxReplyChainDepth, () => bigContent);
    const current = messages.at(-1)!;
    const chain = await resolveReplyChain(turnSupport(), current);
    expect(chain.length).toBeLessThan(chatMemoryLimits.maxReplyChainDepth);
    const budgetUsed = chain.reduce((sum, hop) => sum + Math.min(hop.content.length, chatMemoryLimits.maxUserMessageChars), 0);
    expect(budgetUsed).toBeLessThanOrEqual(chatMemoryLimits.maxReplyChainChars);
  });

  it("stops cleanly on a broken link instead of throwing", async () => {
    // 3-hop chain where fetching m0 (from m1) fails, e.g. a deleted message.
    const messages = chainOf(3, undefined, new Set(["m0"]));
    const current = messages.at(-1)!;
    const chain = await resolveReplyChain(turnSupport(), current);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.id).toBe("m1");
  });

  it("returns an empty chain when the current message isn't a reply", async () => {
    const [onlyMessage] = chainOf(1);
    const chain = await resolveReplyChain(turnSupport(), onlyMessage!);
    expect(chain).toHaveLength(0);
  });
});

describe("ChatTurnSupport channel history resolution", () => {
  it("returns fetched messages oldest-first", async () => {
    const message = fakeChannelMessage([
      { id: "c3", content: "third" },
      { id: "c2", content: "second" },
      { id: "c1", content: "first" },
    ]);
    const history = await resolveChannelHistory(turnSupport(), message, 8);
    expect(history.map((m) => m.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("excludes IDs already present in the reply chain", async () => {
    const message = fakeChannelMessage([
      { id: "c3", content: "third" },
      { id: "c2", content: "second" },
      { id: "c1", content: "first" },
    ]);
    const history = await resolveChannelHistory(turnSupport(), message, 8, new Set(["c2"]));
    expect(history.map((m) => m.id)).toEqual(["c1", "c3"]);
  });

  it("stops early once the char budget is exhausted, keeping the most recent messages", async () => {
    const bigContent = "x".repeat(chatMemoryLimits.maxUserMessageChars);
    const history = await resolveChannelHistory(
      turnSupport(),
      fakeChannelMessage([
        { id: "c5", content: bigContent },
        { id: "c4", content: bigContent },
        { id: "c3", content: bigContent },
        { id: "c2", content: bigContent },
        { id: "c1", content: bigContent },
      ]),
      8,
    );
    expect(history.length).toBeLessThan(5);
    // Nearest-to-current (highest id) wins once the budget is hit.
    expect(history.at(-1)?.id).toBe("c5");
    const budgetUsed = history.reduce((sum, m) => sum + Math.min(m.content.length, chatMemoryLimits.maxUserMessageChars), 0);
    expect(budgetUsed).toBeLessThanOrEqual(chatMemoryLimits.maxChannelHistoryChars);
  });

  it("returns an empty list when the fetch fails, instead of throwing", async () => {
    const history = await resolveChannelHistory(turnSupport(), fakeChannelMessage([], true), 8);
    expect(history).toHaveLength(0);
  });

  it("returns an empty list when there is no channel history", async () => {
    const history = await resolveChannelHistory(turnSupport(), fakeChannelMessage([]), 8);
    expect(history).toHaveLength(0);
  });
});
