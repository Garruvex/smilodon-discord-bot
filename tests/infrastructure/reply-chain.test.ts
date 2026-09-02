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

function resolveReplyChain(
  support: ChatTurnSupport,
  message: FakeMessage,
): Promise<{ kept: FakeMessage[]; overflow: FakeMessage[] }> {
  return support.resolveReplyChain(message as never) as unknown as Promise<{ kept: FakeMessage[]; overflow: FakeMessage[] }>;
}

interface FakeChannelMessage {
  id: string;
  content: string;
  author?: { id: string; bot: boolean };
}

// Discord's channel.messages.fetch({ limit, before }) returns a
// Collection (Map-like) ordered newest-first — this fake mirrors that.
// Each entry defaults to a distinct non-bot author (its own id) unless
// overridden, so pre-existing tests that never specify `author` stay under
// the human budget exactly as before this fake grew author-awareness.
function fakeChannelMessage(
  historyNewestFirst: readonly FakeChannelMessage[],
  fetchError = false,
  selfId: string | null = "self-bot",
): FakeMessage {
  const fetch = vi.fn(() => {
    if (fetchError) return Promise.reject(new Error("channel unavailable"));
    const map = new Map(historyNewestFirst.map((entry) => [
      entry.id,
      { ...entry, author: entry.author ?? { id: entry.id, bot: false } },
    ]));
    return Promise.resolve(map);
  });
  return {
    id: "current",
    content: "current message",
    channel: { messages: { fetch: fetch as never } },
    client: { user: selfId ? { id: selfId } : null },
  } as unknown as FakeMessage;
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
    const { kept } = await resolveReplyChain(turnSupport(), current);
    expect(kept).toHaveLength(chatMemoryLimits.maxReplyChainDepth);
    // Oldest-first: the last entry should be the immediate parent of `current`.
    expect(kept.at(-1)?.id).toBe(messages.at(-2)?.id);
  });

  it("stops early once the char budget is exhausted, even under the depth cap", async () => {
    const bigContent = "x".repeat(chatMemoryLimits.maxUserMessageChars);
    const messages = chainOf(chatMemoryLimits.maxReplyChainDepth, () => bigContent);
    const current = messages.at(-1)!;
    const { kept } = await resolveReplyChain(turnSupport(), current);
    expect(kept.length).toBeLessThan(chatMemoryLimits.maxReplyChainDepth);
    const budgetUsed = kept.reduce((sum, hop) => sum + Math.min(hop.content.length, chatMemoryLimits.maxUserMessageChars), 0);
    expect(budgetUsed).toBeLessThanOrEqual(chatMemoryLimits.maxReplyChainChars);
  });

  it("stops cleanly on a broken link instead of throwing", async () => {
    // 3-hop chain where fetching m0 (from m1) fails, e.g. a deleted message.
    const messages = chainOf(3, undefined, new Set(["m0"]));
    const current = messages.at(-1)!;
    const { kept } = await resolveReplyChain(turnSupport(), current);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.id).toBe("m1");
  });

  it("returns an empty chain when the current message isn't a reply", async () => {
    const [onlyMessage] = chainOf(1);
    const { kept, overflow } = await resolveReplyChain(turnSupport(), onlyMessage!);
    expect(kept).toHaveLength(0);
    expect(overflow).toHaveLength(0);
  });

  it("gathers overflow beyond the depth cap, without fetching anything extra for a shallow chain", async () => {
    // Total ancestors above `current` = maxReplyChainDepth (kept) + 3 (overflow).
    const messages = chainOf(chatMemoryLimits.maxReplyChainDepth + 4);
    const current = messages.at(-1)!;
    const { kept, overflow } = await resolveReplyChain(turnSupport(), current);
    expect(kept).toHaveLength(chatMemoryLimits.maxReplyChainDepth);
    // The 3 hops older than the kept window, oldest-first.
    expect(overflow.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
  });

  it("returns empty overflow, with zero extra fetches, when the whole thread already fit in `kept`", async () => {
    const messages = chainOf(chatMemoryLimits.maxReplyChainDepth - 1);
    const current = messages.at(-1)!;
    const { kept, overflow } = await resolveReplyChain(turnSupport(), current);
    expect(kept.length).toBe(messages.length - 1);
    expect(overflow).toHaveLength(0);
  });
});

describe("ChatTurnSupport channel history resolution", () => {
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

    const history = turnSupport().toChannelHistoryMessages([fluffy, botReply] as never);

    expect(history[1]).toMatchObject({
      authorId: "bot",
      replyToAuthorId: "fluffy",
      replyToAuthorDisplayName: "Fluffy",
    });
  });

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

  it("budgets its own replies separately so they don't crowd out human speakers", async () => {
    // A busy channel where the bot (self-bot) replies after nearly every
    // human message — interleaved newest-first, as Discord returns it.
    const history = await resolveChannelHistory(
      turnSupport(),
      fakeChannelMessage([
        { id: "b4", content: "self reply 4", author: { id: "self-bot", bot: true } },
        { id: "h4", content: "human 4", author: { id: "human", bot: false } },
        { id: "b3", content: "self reply 3", author: { id: "self-bot", bot: true } },
        { id: "h3", content: "human 3", author: { id: "human", bot: false } },
        { id: "b2", content: "self reply 2", author: { id: "self-bot", bot: true } },
        { id: "h2", content: "human 2", author: { id: "human", bot: false } },
        { id: "b1", content: "self reply 1", author: { id: "self-bot", bot: true } },
        { id: "h1", content: "human 1", author: { id: "human", bot: false } },
      ]),
      4,
    );
    // humanBudget = limit (4): all 4 human messages survive. selfBudget =
    // ceil(4/2) = 2: only the 2 most recent of the bot's own replies do —
    // a flat "last 4" fetch would have kept only b4/h4/b3/h3, losing h1/h2.
    expect(history.filter((m) => m.author?.bot).map((m) => m.id)).toEqual(["b3", "b4"]);
    expect(history.filter((m) => !m.author?.bot).map((m) => m.id)).toEqual(["h1", "h2", "h3", "h4"]);
  });

  it("excludes third-party bot messages entirely (noise, not conversational context)", async () => {
    const history = await resolveChannelHistory(
      turnSupport(),
      fakeChannelMessage([
        { id: "m2", content: "level up!", author: { id: "leveling-bot", bot: true } },
        { id: "m1", content: "hello", author: { id: "human", bot: false } },
      ]),
      8,
    );
    expect(history.map((m) => m.id)).toEqual(["m1"]);
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
