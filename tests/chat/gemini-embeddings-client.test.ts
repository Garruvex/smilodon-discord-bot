import type { GoogleGenAI } from "@google/genai";
import { describe, expect, it, vi } from "vitest";

import { GeminiEmbeddingsClient } from "../../src/infrastructure/chat/gemini-embeddings-client.js";

describe("GeminiEmbeddingsClient", () => {
  it("checks authorization and cancellation before dispatching a batch", async () => {
    const embedContent = vi.fn();
    const client = new GeminiEmbeddingsClient("secret", "test", 1536, { models: { embedContent } } as unknown as GoogleGenAI);
    await expect(client.embedMany(["SECRET"], { beforeAttempt: () => Promise.reject(new Error("revoked")) })).rejects.toThrow("revoked");
    await expect(client.embed("SECRET", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(embedContent).not.toHaveBeenCalled();
  });
  it("batches separate contents and preserves response order", async () => {
    const embedContent = vi.fn<(request: unknown) => Promise<{ embeddings: { values: number[] }[] }>>().mockResolvedValue({
      embeddings: [{ values: [1, 0] }, { values: [0, 1] }],
    });
    const client = new GeminiEmbeddingsClient("key", "gemini-embedding-001", 1536, {
      models: { embedContent },
    } as unknown as GoogleGenAI);

    await expect(client.embedMany(["alpha", "beta"])).resolves.toEqual([[1, 0], [0, 1]]);
    expect(embedContent).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-embedding-001",
      contents: [
        { parts: [{ text: "alpha" }] },
        { parts: [{ text: "beta" }] },
      ],
    }));
    const [request] = embedContent.mock.calls[0]!;
    expect((request as { config: { outputDimensionality: number } }).config.outputDimensionality).toBe(1536);
  });

  it("rejects incomplete batch responses", async () => {
    const client = new GeminiEmbeddingsClient("key", "gemini-embedding-001", 1536, {
      models: { embedContent: vi.fn().mockResolvedValue({ embeddings: [{ values: [1] }] }) },
    } as unknown as GoogleGenAI);

    await expect(client.embedMany(["alpha", "beta"])).rejects.toThrow("incomplete batch");
  });
});
