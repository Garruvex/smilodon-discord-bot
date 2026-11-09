import type { EmbeddingsClient, EmbeddingCallOptions } from "./embeddings-client.js";
import { hashContent } from "../assets/content-hash.js";

/**
 * Memoizes `embed` by exact text in a small LRU, caching the in-flight
 * promise (not just the result) so concurrent callers embedding the same
 * text share one API call. A chat turn's memory recall and persona lore/
 * example selectors all embed the same query text in parallel (see
 * buildEmbeddingQueryText); without this each would pay its own round trip.
 * Rejections are evicted so a transient failure isn't cached.
 */
export class CachingEmbeddingsClient implements EmbeddingsClient {
  public readonly modelId: string;
  public readonly embedMany?: (texts: readonly string[], options?: EmbeddingCallOptions) => Promise<number[][]>;
  private readonly cache = new Map<string, Promise<number[]>>();

  public constructor(
    private readonly inner: EmbeddingsClient,
    private readonly maxEntries = 32,
  ) {
    this.modelId = inner.modelId;
    if (inner.embedMany) {
      const embedMany = inner.embedMany.bind(inner);
      this.embedMany = async (texts, options): Promise<number[][]> => {
        await options?.beforeAttempt?.(); options?.signal?.throwIfAborted();
        const result = await embedMany(texts, options);
        await options?.beforeAttempt?.(); options?.signal?.throwIfAborted(); return result;
      };
    }
  }

  public async embed(text: string, options?: EmbeddingCallOptions): Promise<number[]> {
    await options?.beforeAttempt?.(); options?.signal?.throwIfAborted();
    const key = `${options?.cacheScope ?? "legacy"}:${hashContent(text)}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      try {
        const result = await cached; await options?.beforeAttempt?.(); options?.signal?.throwIfAborted(); return result;
      } catch (error) { this.cache.delete(key); throw error; }
    }
    const pending = this.inner.embed(text, options);
    this.cache.set(key, pending);
    pending.catch(() => {
      if (this.cache.get(key) === pending) this.cache.delete(key);
    });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    try {
      const result = await pending; await options?.beforeAttempt?.(); options?.signal?.throwIfAborted(); return result;
    } catch (error) { if (this.cache.get(key) === pending) this.cache.delete(key); throw error; }
  }
}
