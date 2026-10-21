import { describe, expect, it, vi } from "vitest";

import { CachingEmbeddingsClient } from "../../src/application/chat/caching-embeddings-client.js";

describe("CachingEmbeddingsClient", () => {
  it("partitions identical text by authorized audience/purpose scope", async () => {
    const embed = vi.fn(() => Promise.resolve([1])); const client = new CachingEmbeddingsClient({ embed, modelId: "test" });
    await client.embed("same", { cacheScope: "guild-a:private:query" });
    await client.embed("same", { cacheScope: "guild-b:public:query" });
    await client.embed("same", { cacheScope: "guild-a:private:query" });
    expect(embed).toHaveBeenCalledTimes(2);
  });
  it("rechecks cached results and never returns a vector after revocation", async () => {
    const embed = vi.fn(() => Promise.resolve([1])); const client = new CachingEmbeddingsClient({ embed, modelId: "test" });
    let allowed = true;
    const options = { cacheScope: "source-version", beforeAttempt: (): Promise<void> => allowed ? Promise.resolve() : Promise.reject(new Error("revoked")) };
    await client.embed("private", options); allowed = false;
    await expect(client.embed("private", options)).rejects.toThrow("revoked");
    expect(embed).toHaveBeenCalledOnce();
  });
  it("evicts a vector when its authorization changes during processing", async () => {
    let allowed = true;
    const embed = vi.fn(() => { allowed = false; return Promise.resolve([1]); }); const client = new CachingEmbeddingsClient({ embed, modelId: "test" });
    const options = { cacheScope: "source-version", beforeAttempt: (): Promise<void> => allowed ? Promise.resolve() : Promise.reject(new Error("revoked")) };
    await expect(client.embed("private", options)).rejects.toThrow("revoked");
    allowed = true; await expect(client.embed("private", options)).rejects.toThrow("revoked");
    expect(embed).toHaveBeenCalledTimes(2);
  });
  it("shares one underlying call between concurrent requests for the same text", async () => {
    const embed = vi.fn(() => Promise.resolve([1, 2]));
    const client = new CachingEmbeddingsClient({ embed, modelId: "test-model" });

    const results = await Promise.all([client.embed("hello"), client.embed("hello"), client.embed("hello")]);

    expect(embed).toHaveBeenCalledTimes(1);
    expect(results).toEqual([[1, 2], [1, 2], [1, 2]]);
  });

  it("does not cache a rejection, so the next call retries", async () => {
    const embed = vi.fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce([3]);
    const client = new CachingEmbeddingsClient({ embed, modelId: "test-model" });

    await expect(client.embed("hello")).rejects.toThrow("down");
    await expect(client.embed("hello")).resolves.toEqual([3]);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used entry past its capacity", async () => {
    const embed = vi.fn((text: string) => Promise.resolve([text.length]));
    const client = new CachingEmbeddingsClient({ embed, modelId: "test-model" }, 2);

    await client.embed("a");
    await client.embed("bb");
    await client.embed("a");
    await client.embed("ccc");
    await client.embed("a");
    await client.embed("bb");

    expect(embed.mock.calls.map(([text]) => text)).toEqual(["a", "bb", "ccc", "bb"]);
  });

  it("passes through the wrapped client's modelId and embedMany", async () => {
    const embedMany = vi.fn(() => Promise.resolve([[1], [2]]));
    const client = new CachingEmbeddingsClient({ embed: vi.fn(), embedMany, modelId: "test-model" });

    expect(client.modelId).toBe("test-model");
    await expect(client.embedMany?.(["a", "b"])).resolves.toEqual([[1], [2]]);
  });
});
