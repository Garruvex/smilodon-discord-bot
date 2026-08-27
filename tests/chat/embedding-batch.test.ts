import { describe, expect, it, vi } from "vitest";

import {
  embeddingBatchSize,
  embedTextsBestEffort,
} from "../../src/application/chat/embedding-batch.js";
import type { EmbeddingsClient } from "../../src/application/chat/embeddings-client.js";

describe("embedTextsBestEffort", () => {
  it("embeds inputs in bounded batches and preserves their order", async () => {
    const embed = vi.fn(() => Promise.reject(new Error("individual fallback should not run")));
    const embedMany = vi.fn((texts: readonly string[]) =>
      Promise.resolve(texts.map((text) => [Number(text)])));
    const texts = Array.from({ length: embeddingBatchSize * 2 + 6 }, (_, index) => String(index));

    const result = await embedTextsBestEffort(texts, { embed, embedMany });

    expect(embedMany.mock.calls.map(([batch]) => batch.length)).toEqual([32, 32, 6]);
    expect(embed).not.toHaveBeenCalled();
    expect(result).toEqual(texts.map((text) => [Number(text)]));
  });

  it("falls back per item when a batch fails", async () => {
    const client: EmbeddingsClient = {
      embedMany: () => Promise.reject(new Error("batch rejected")),
      embed: (text) => text === "bad"
        ? Promise.reject(new Error("input rejected"))
        : Promise.resolve([text.length]),
    };

    await expect(embedTextsBestEffort(["ok", "bad", "fine"], client)).resolves.toEqual([
      [2],
      null,
      [4],
    ]);
  });
});
