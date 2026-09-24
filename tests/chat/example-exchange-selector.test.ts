import { describe, expect, it, vi } from "vitest";

import { RelevantExampleExchangeSelector } from "../../src/application/chat/example-exchange-selector.js";
import { exampleExchangeLimits, type ExampleExchange } from "../../src/application/chat/example-exchange.js";
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";

function exchange(overrides: Partial<ExampleExchange> = {}): ExampleExchange {
  return { tags: "", user: "placeholder", character: "placeholder", ...overrides };
}

describe("RelevantExampleExchangeSelector", () => {
  it("ranks a lexically-matching Chinese example above an unrelated one", async () => {
    const examTalk = exchange({
      tags: "考試, 學校",
      user: "我今天期中考炸了",
      character: "草ww 哪科啦",
    });
    const unrelated = exchange({
      tags: "音樂, 推薦",
      user: "推薦一首歌",
      character: "聽聽這首吧",
    });
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({
      records: [unrelated, examTalk],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "期中考 炸了",
      now: 1_000,
    });

    expect(selected[0]).toEqual(examTalk);
  });

  it("ranks a lexically-matching example above an unrelated one", async () => {
    const examTalk = exchange({
      tags: "exam school venting",
      user: "my midterm exam went badly today",
      character: "lol rip which subject",
    });
    const unrelated = exchange({
      tags: "music recommendation",
      user: "recommend me a song",
      character: "listen to this one",
    });
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({
      records: [unrelated, examTalk],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "my exam today was a disaster",
      now: 1_000,
    });

    expect(selected[0]).toEqual(examTalk);
  });

  it("returns an empty array without erroring when there are no examples", async () => {
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({
      records: [],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "anything",
      now: 1_000,
    });

    expect(selected).toHaveLength(0);
  });

  it("keeps as many examples as fit under the serialized char budget", async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      exchange({ tags: `topic${i}`, user: `message ${i}`, character: `reply ${i}` }));
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({
      records: many,
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "message",
      now: 1_000,
    });

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThanOrEqual(many.length);
  });

  it("skips the per-turn embed call when no record carries an embedding, staying lexical-only", async () => {
    const embed = vi.fn(() => Promise.resolve([1, 0]));
    const examTalk = exchange({ tags: "exam", user: "my exam went badly", character: "rip" });
    const selector = new RelevantExampleExchangeSelector({ embed, modelId: "test-model" });

    await selector.select({
      records: [examTalk],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "my exam today was a disaster",
      now: 1_000,
    });

    expect(embed).not.toHaveBeenCalled();
  });

  it("embeds the current message when at least one record carries an embedding", async () => {
    const embed = vi.fn(() => Promise.resolve([1, 0]));
    const examTalk = exchange({ tags: "exam", user: "my exam went badly", character: "rip", embedding: [1, 0] });
    const selector = new RelevantExampleExchangeSelector({ embed, modelId: "test-model" });

    await selector.select({
      records: [examTalk],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "my exam today was a disaster",
      now: 1_000,
    });

    expect(embed).toHaveBeenCalledWith("my exam today was a disaster");
  });

  it("excludes embedding from the serialized prompt-budget projection", async () => {
    const bigEmbedding = Array.from({ length: 1_536 }, () => 0.123456789);
    const withEmbedding = exchange({ tags: "a", user: "hello", character: "hi", embedding: bigEmbedding });
    const failingClient: EmbeddingsClient = { embed: () => Promise.reject(new Error("down")), modelId: "test-model" };
    const selector = new RelevantExampleExchangeSelector(failingClient);

    const selected = await selector.select({
      records: [withEmbedding],
      currentUser: { id: "user", displayName: "User", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      message: "hello",
      now: 1_000,
    });

    expect(selected).toHaveLength(1);
  });

  // Real (Date.now()-scale) `now` for the tests below — with updatedAt
  // hardcoded to 0 for every example (see toScorable), a small `now` makes
  // bm25Score's recency term dominate and masks the zero-lexical-overlap
  // cases they target. At real epoch scale that recency term is always ~0,
  // same as production.
  const realisticNow = Date.now();
  const baseInput = {
    currentUser: { id: "user", displayName: "User", roleNames: [] },
    mentionedUsers: [],
    recentHistory: [],
    now: realisticNow,
  };

  it("gives relevance slots only to examples that clear the floor, then tops up to the baseline in file order", async () => {
    const unrelated = ["music song", "cooking pasta", "gaming controller", "weather forecast"].map((topic) =>
      exchange({ tags: topic, user: `talk about ${topic}`, character: "sure" }));
    const examTalk = exchange({ tags: "exam", user: "my exam went badly", character: "rip" });
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({
      ...baseInput,
      records: [...unrelated, examTalk],
      message: "my exam today was a disaster",
    });

    expect(selected).toEqual([examTalk, unrelated[0], unrelated[1]]);
  });

  it("still sends a baseline of examples when nothing is relevant, rather than none", async () => {
    const records = ["music song", "cooking pasta", "gaming controller", "weather forecast"].map((topic) =>
      exchange({ tags: topic, user: `talk about ${topic}`, character: "sure" }));
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({ ...baseInput, records, message: "mars rover landing" });

    expect(selected).toEqual(records.slice(0, exampleExchangeLimits.minSelected));
  });

  it("requires embedding similarity to clear a real threshold, not just be above zero", async () => {
    // Barely-positive cosine similarity (0.05) is the kind of noise
    // unrelated vectors commonly produce in a real embedding space — not a
    // genuine relevance signal, so it must not win a relevance slot.
    const noise = exchange({ tags: "a", user: "alpha", character: "x", embedding: [1, 0, 0, 0] });
    const first = exchange({ tags: "b", user: "bravo", character: "x", embedding: [0, 1, 0, 0] });
    const second = exchange({ tags: "c", user: "charlie", character: "x", embedding: [0, 0, 1, 0] });
    const match = exchange({ tags: "d", user: "delta", character: "x", embedding: [0, 0, 0, 1] });
    const embed = vi.fn(() => Promise.resolve([0.05, 0, 0, Math.sqrt(1 - 0.05 ** 2)]));
    const selector = new RelevantExampleExchangeSelector({ embed, modelId: "test-model" });

    const selected = await selector.select({
      ...baseInput,
      records: [first, second, noise, match],
      message: "nothing lexically shared",
    });

    expect(selected).toEqual([match, first, second]);
  });

  it("caps the selection at maxSelected even when more examples are relevant and fit the budget", async () => {
    const many = Array.from({ length: 20 }, (_, i) => exchange({ tags: `exam${i}`, user: "exam stress", character: `reply ${i}` }));
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({ ...baseInput, records: many, message: "exam" });

    expect(selected).toHaveLength(exampleExchangeLimits.maxSelected);
  });

  it("skips an example whose situation is a near-duplicate of one already selected", async () => {
    const original = exchange({ tags: "exam", user: "my exam went badly", character: "rip", embedding: [1, 0] });
    const duplicate = exchange({ tags: "exam", user: "my exam went badly again", character: "oof", embedding: [1, 0.01] });
    const different = exchange({ tags: "exam", user: "exam results are out", character: "nice", embedding: [0, 1] });
    const selector = new RelevantExampleExchangeSelector({ embed: (): Promise<number[]> => Promise.resolve([1, 0]), modelId: "test-model" });

    const selected = await selector.select({ ...baseInput, records: [original, duplicate, different], message: "exam" });

    expect(selected).toContain(original);
    expect(selected).toContain(different);
    expect(selected).not.toContain(duplicate);
  });

  it("matches on the example's situation (tags + User line), not the Character reply", async () => {
    const replyMentions = exchange({ tags: "greeting", user: "hello there", character: "want to talk about pizza?" });
    const situationMatches = exchange({ tags: "food", user: "what pizza should I order", character: "pineapple, obviously" });
    const selector = new RelevantExampleExchangeSelector();

    const selected = await selector.select({ ...baseInput, records: [replyMentions, situationMatches], message: "pizza" });

    expect(selected[0]).toEqual(situationMatches);
  });

  it("embeds the direct reply-chain parent alongside the current message", async () => {
    const embed = vi.fn(() => Promise.resolve([1, 0]));
    const selector = new RelevantExampleExchangeSelector({ embed, modelId: "test-model" });

    await selector.select({
      ...baseInput,
      records: [exchange({ embedding: [1, 0] })],
      message: "what do you think?",
      replyChain: [{ content: "is pineapple on pizza okay" }],
    });

    expect(embed).toHaveBeenCalledWith("is pineapple on pizza okay\nwhat do you think?");
  });
});
