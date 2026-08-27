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
    const failingClient: EmbeddingsClient = { embed: () => Promise.reject(new Error("embeddings down")) };
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
    const selector = new RelevantPersonaLoreSelector({ embed });

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
    const selector = new RelevantPersonaLoreSelector({ embed });

    await selector.select({
      chunks: [chunk({ embedding: [1, 0] })],
      recentHistory: [],
      message: "where were you born",
      now: 1_000,
    });

    expect(embed).toHaveBeenCalledWith("where were you born");
  });
});
