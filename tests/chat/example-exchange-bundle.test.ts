import { describe, expect, it, vi } from "vitest";

import {
  buildExampleExchangeBundle,
  exampleExchangeEmbeddingTextVersion,
  type ExampleExchangeBundle,
} from "../../src/application/chat/example-exchange-bundle.js";

const exchanges = [
  { tags: "greeting", user: "hi", character: "hey there" },
  { tags: "exam", user: "my exam went badly", character: "rip" },
];

function previous(overrides: Partial<ExampleExchangeBundle> = {}): ExampleExchangeBundle {
  return {
    sourceHash: "old",
    exchanges: [{ tags: "greeting", user: "hi", character: "a different old reply", embedding: [7, 7] }],
    embeddingModel: "test-model",
    embeddingTextVersion: exampleExchangeEmbeddingTextVersion,
    ...overrides,
  };
}

describe("buildExampleExchangeBundle", () => {
  it("embeds each example's situation (tags + User line), not the Character reply", async () => {
    const embed = vi.fn((_text: string) => Promise.resolve([1, 0]));

    const bundle = await buildExampleExchangeBundle("content", exchanges, { embed, modelId: "test-model" });

    expect(embed.mock.calls.map(([text]) => text)).toEqual(["greeting\nhi", "exam\nmy exam went badly"]);
    expect(bundle.embeddingTextVersion).toBe(exampleExchangeEmbeddingTextVersion);
  });

  it("reuses a previous vector for an unchanged situation, even if the reply text changed", async () => {
    const embed = vi.fn((_text: string) => Promise.resolve([1, 0]));

    const bundle = await buildExampleExchangeBundle("content", exchanges, { embed, modelId: "test-model" }, previous());

    expect(embed.mock.calls.map(([text]) => text)).toEqual(["exam\nmy exam went badly"]);
    expect(bundle.exchanges.map((exchange) => exchange.embedding)).toEqual([[7, 7], [1, 0]]);
  });

  it("re-embeds everything when the previous bundle used another model or embedding-text scheme", async () => {
    for (const stale of [previous({ embeddingModel: "other-model" }), previous({ embeddingTextVersion: 1 })]) {
      const embed = vi.fn((_text: string) => Promise.resolve([1, 0]));

      const bundle = await buildExampleExchangeBundle("content", exchanges, { embed, modelId: "test-model" }, stale);

      expect(embed).toHaveBeenCalledTimes(2);
      expect(bundle.exchanges[0]!.embedding).toEqual([1, 0]);
    }
  });
});
