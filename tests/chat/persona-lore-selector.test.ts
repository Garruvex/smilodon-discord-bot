import { describe, expect, it, vi } from "vitest";

import { RelevantPersonaLoreSelector } from "../../src/application/chat/persona-lore-selector.js";
import type { PersonaLoreChunk } from "../../src/application/chat/persona-source.js";
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";

function chunk(overrides: Partial<PersonaLoreChunk> = {}): PersonaLoreChunk {
  return { heading: "Untitled", text: "placeholder", embedding: null, ...overrides };
}

describe("RelevantPersonaLoreSelector", () => {
  it("ranks a lexically-matching chunk above an unrelated one", async () => {
    const backstory = chunk({ heading: "Backstory", text: "Born in a quiet forest near the river." });
    const unrelated = chunk({ heading: "Favorite food", text: "Loves spicy noodles and cold tea." });
    const selector = new RelevantPersonaLoreSelector();

    const selected = await selector.select({
      chunks: [unrelated, backstory],
      recentHistory: [],
      message: "where were you born",
      now: 1_000,
    });

    expect(selected[0]).toEqual(backstory);
  });

  it("returns an empty array without erroring when there are no chunks", async () => {
    const selector = new RelevantPersonaLoreSelector();

    const selected = await selector.select({ chunks: [], recentHistory: [], message: "anything", now: 1_000 });

    expect(selected).toHaveLength(0);
  });

  it("keeps as many chunks as fit under the serialized char budget", async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      chunk({ heading: `topic${i}`, text: `some lore about topic ${i}` }));
    const selector = new RelevantPersonaLoreSelector();

    const selected = await selector.select({ chunks: many, recentHistory: [], message: "topic", now: 1_000 });

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThanOrEqual(many.length);
  });

  it("falls back to lexical-only ranking when the embeddings client rejects", async () => {
    const backstory = chunk({ heading: "Backstory", text: "Born in a quiet forest near the river.", embedding: [1, 0] });
    const unrelated = chunk({ heading: "Favorite food", text: "Loves spicy noodles and cold tea.", embedding: [0, 1] });
    const failingClient: EmbeddingsClient = { embed: () => Promise.reject(new Error("embeddings down")), modelId: "test-model" };
    const selector = new RelevantPersonaLoreSelector(failingClient);

    const selected = await selector.select({
      chunks: [unrelated, backstory],
      recentHistory: [],
      message: "where were you born",
      now: 1_000,
    });

    expect(selected[0]).toEqual(backstory);
  });

  it("skips the per-turn embed call when no chunk carries an embedding", async () => {
    const embed = vi.fn(() => Promise.resolve([1, 0]));
    const selector = new RelevantPersonaLoreSelector({ embed, modelId: "test-model" });

    await selector.select({
      chunks: [chunk({ heading: "Backstory", text: "Born in a forest." })],
      recentHistory: [],
      message: "where were you born",
      now: 1_000,
    });

    expect(embed).not.toHaveBeenCalled();
  });

  it("embeds the current message against a configured embeddings client", async () => {
    const embed = vi.fn(() => Promise.resolve([1, 0]));
    const selector = new RelevantPersonaLoreSelector({ embed, modelId: "test-model" });

    await selector.select({
      chunks: [chunk({ embedding: [1, 0] })],
      recentHistory: [],
      message: "where were you born",
      now: 1_000,
    });

    expect(embed).toHaveBeenCalledWith("where were you born");
  });

  it("embeds the direct reply-chain message and its summary alongside the current message", async () => {
    const embed = vi.fn(() => Promise.resolve([1, 0]));
    const selector = new RelevantPersonaLoreSelector({ embed, modelId: "test-model" });

    await selector.select({
      chunks: [chunk({ embedding: [1, 0] })],
      recentHistory: [],
      message: "what do you think?",
      now: 1_000,
      replyChain: [{ content: "older hop" }, { content: "have you ever been near the river" }],
      replyChainSummary: "earlier: discussed the old mill",
    });

    expect(embed).toHaveBeenCalledWith(
      "what do you think?\nhave you ever been near the river\nearlier: discussed the old mill",
    );
  });

  it("finds an embedding-only match via the reply chain when neither message nor reply hop share a word with the chunk", async () => {
    // The embed stub only "recognizes" childhood-related text — standing in
    // for a real embeddings model that would put semantically similar text
    // ("where were you raised") close to the Backstory chunk's vector even
    // with zero literal word overlap ("Grew up near the river").
    const embed = vi.fn((text: string) => Promise.resolve(text.includes("raised") ? [1, 0] : [0, 1]));
    const backstory = chunk({ heading: "Backstory", text: "Grew up near the river.", embedding: [1, 0] });
    const unrelated = chunk({ heading: "Favorite food", text: "Loves spicy noodles and cold tea.", embedding: [0, 1] });
    const selector = new RelevantPersonaLoreSelector({ embed, modelId: "test-model" });

    const selected = await selector.select({
      chunks: [unrelated, backstory],
      recentHistory: [],
      message: "what do you think?",
      now: Date.now(),
      replyChain: [{ content: "where were you raised" }],
    });

    expect(selected).toEqual([backstory]);
  });

  // Real (Date.now()-scale) `now` values, not the small `1_000` most tests
  // above use — with updatedAt hardcoded to 0 for every lore chunk (see
  // toScorable), a small `now` makes bm25Score's recency term dominate and
  // masks the zero-lexical-overlap case these tests target. At real epoch
  // scale that recency term is always ~0, same as production.
  const realisticNow = Date.now();

  it("excludes chunks with zero lexical overlap and zero embedding similarity, even with budget to spare", async () => {
    const unrelated = chunk({ heading: "Favorite food", text: "Loves spicy noodles and cold tea." });
    const selector = new RelevantPersonaLoreSelector();

    const selected = await selector.select({
      chunks: [unrelated],
      recentHistory: [],
      message: "tell me about the weather on mars",
      now: realisticNow,
    });

    expect(selected).toHaveLength(0);
  });

  it("still selects a chunk whose only signal is embedding similarity, not lexical overlap", async () => {
    const backstory = chunk({ heading: "Backstory", text: "Grew up near the river.", embedding: [1, 0] });
    const embed = vi.fn(() => Promise.resolve([1, 0]));
    const selector = new RelevantPersonaLoreSelector({ embed, modelId: "test-model" });

    const selected = await selector.select({
      chunks: [backstory],
      recentHistory: [],
      message: "unrelated words with no overlap",
      now: realisticNow,
    });

    expect(selected).toEqual([backstory]);
  });

  it("uses the reply chain, not just the literal current message, to find relevant lore", async () => {
    const backstory = chunk({ heading: "Backstory", text: "Born in a quiet forest near the river." });
    const unrelated = chunk({ heading: "Favorite food", text: "Loves spicy noodles and cold tea." });
    const selector = new RelevantPersonaLoreSelector();

    const selected = await selector.select({
      chunks: [unrelated, backstory],
      recentHistory: [],
      message: "what do you think?",
      now: realisticNow,
      replyChain: [{ content: "where were you born" }],
    });

    expect(selected).toEqual([backstory]);
  });
});
