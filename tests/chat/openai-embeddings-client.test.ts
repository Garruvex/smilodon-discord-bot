import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiEmbeddingsClient } from "../../src/infrastructure/chat/openai-embeddings-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAiEmbeddingsClient", () => {
  it("keeps scalar requests for single-text embedding calls", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      expect(JSON.parse(init.body)).toMatchObject({ input: "single" });
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ index: 0, embedding: [1, 0] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAiEmbeddingsClient(
      "https://api.openai.com/v1",
      "secret",
      "text-embedding-3-small",
    );

    await expect(client.embed("single")).resolves.toEqual([1, 0]);
  });

  it("sends an input array and restores response vectors to input order", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      expect(JSON.parse(init.body)).toEqual({
        model: "text-embedding-3-small",
        input: ["first", "second"],
      });
      return Promise.resolve(new Response(JSON.stringify({
        data: [
          { index: 1, embedding: [2, 0] },
          { index: 0, embedding: [1, 0] },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAiEmbeddingsClient(
      "https://api.openai.com/v1",
      "secret",
      "text-embedding-3-small",
    );

    await expect(client.embedMany(["first", "second"])).resolves.toEqual([[1, 0], [2, 0]]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects incomplete indexed batches", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }))));
    const client = new OpenAiEmbeddingsClient(
      "https://api.openai.com/v1",
      "secret",
      "text-embedding-3-small",
    );

    await expect(client.embedMany(["first", "second"])).rejects.toThrow("incomplete batch");
  });

  it("distinguishes two OpenAI-compatible deployments serving the same model name via baseUrl", () => {
    const official = new OpenAiEmbeddingsClient("https://api.openai.com/v1", "secret", "text-embedding-3-small");
    const selfHosted = new OpenAiEmbeddingsClient("https://embeddings.internal/v1", "secret", "text-embedding-3-small");

    expect(official.modelId).not.toBe(selfHosted.modelId);
  });
});
