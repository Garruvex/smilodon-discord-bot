import { describe, expect, it, vi } from "vitest";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { CachingEmbeddingsClient } from "../../src/application/chat/caching-embeddings-client.js";
import { embedTextsBestEffort } from "../../src/application/chat/embedding-batch.js";
import { approveEmbeddingOperation } from "../../src/application/context/approved-model-operation.js";
import { guardEmbeddingTransport } from "../../src/application/context/guarded-embedding-transport.js";
import { guardedFixture } from "../helpers/guarded-context-fixture.js";

async function fixture(): Promise<{ source: ReturnType<typeof guardedFixture>; context: GuardedConversationContext }> {
  const source = guardedFixture();
  return { source, context: await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] }) };
}
describe("mandatory embedding transport", () => {
  it.each(["missing", "copy", "text", "replay"])("rejects %s authority before the cache or provider", async (kind) => {
    const { context } = await fixture(); const embed = vi.fn((_text: string) => Promise.resolve([1, 0]));
    const transport = guardEmbeddingTransport(new CachingEmbeddingsClient({ modelId: "fixture", embed }));
    const receipt = approveEmbeddingOperation(context, ["admitted"], { cacheScope: "admitted-scope" });
    if (kind === "replay") await transport.embed("admitted", receipt); embed.mockClear();
    await expect(transport.embed(kind === "text" ? "hidden append" : "admitted", kind === "missing" ? undefined : kind === "copy" ? { ...receipt } : receipt))
      .rejects.toBeInstanceOf(SocialOutputSuppressed); expect(embed).not.toHaveBeenCalled();
  });
  it("checks revocation before a cached result can be exposed", async () => {
    const { source, context } = await fixture(); const embed = vi.fn((_text: string) => Promise.resolve([1, 0]));
    const transport = guardEmbeddingTransport(new CachingEmbeddingsClient({ modelId: "fixture", embed }));
    await transport.embed("admitted", approveEmbeddingOperation(context, ["admitted"], { cacheScope: "same" }));
    const second = approveEmbeddingOperation(context, ["admitted"], { cacheScope: "same" }); source.setPolicy(false);
    await expect(transport.embed("admitted", second)).rejects.toBeInstanceOf(SocialOutputSuppressed); expect(embed).toHaveBeenCalledOnce();
  });
  it("checks every waiter on a shared in-flight cache entry", async () => {
    const { source, context } = await fixture(); let release!: (value: number[]) => void; let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const embed = vi.fn((_text: string) => { started(); return new Promise<number[]>((resolve) => { release = resolve; }); });
    const transport = guardEmbeddingTransport(new CachingEmbeddingsClient({ modelId: "fixture", embed }));
    const first = transport.embed("admitted", approveEmbeddingOperation(context, ["admitted"], { cacheScope: "same" }));
    const second = transport.embed("admitted", approveEmbeddingOperation(context, ["admitted"], { cacheScope: "same" }));
    await ready; source.setPolicy(false); release([1, 0]);
    const results = await Promise.allSettled([first, second]); expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(embed).toHaveBeenCalledOnce();
  });
  it("permits bounded individual recovery after a failed batch, preserving duplicates", async () => {
    const { context } = await fixture(); const embed = vi.fn((_text: string) => Promise.resolve([1, 0]));
    const embedMany = vi.fn((_texts: readonly string[]): Promise<number[][]> => Promise.reject(new Error("synthetic batch failure")));
    const transport = guardEmbeddingTransport({ modelId: "fixture", embed, embedMany });
    const texts = ["one", "two", "one"]; const options = approveEmbeddingOperation(context, texts);
    await expect(embedTextsBestEffort(texts, transport, options)).resolves.toEqual([[1, 0], [1, 0], [1, 0]]);
    expect(embedMany).toHaveBeenCalledOnce(); expect(embed).toHaveBeenCalledTimes(3);
    await expect(transport.embed("one", options)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    await expect(transport.embedMany!(texts, options)).rejects.toBeInstanceOf(SocialOutputSuppressed);
  });
  it("does not issue fallback credits after a successful batch", async () => {
    const { context } = await fixture(); const embed = vi.fn((_text: string) => Promise.resolve([1]));
    const transport = guardEmbeddingTransport({ modelId: "fixture", embed, embedMany: (_texts: readonly string[]) => Promise.resolve([[1]]) });
    const options = approveEmbeddingOperation(context, ["one"]); await transport.embedMany!(["one"], options);
    await expect(transport.embed("one", options)).rejects.toBeInstanceOf(SocialOutputSuppressed); expect(embed).not.toHaveBeenCalled();
  });
  it("recovers malformed batch lengths only for the original admitted texts", async () => {
    const { context } = await fixture(); const embed = vi.fn((_text: string) => Promise.resolve([1]));
    const transport = guardEmbeddingTransport({ modelId: "fixture", embed, embedMany: (_texts: readonly string[]) => Promise.resolve([]) });
    const options = approveEmbeddingOperation(context, ["one"]);
    await expect(transport.embedMany!(["one"], options)).rejects.toThrow("length mismatch");
    await expect(transport.embed("private", options)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    await expect(transport.embed("one", options)).resolves.toEqual([1]);
  });
});
