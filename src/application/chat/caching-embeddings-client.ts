import type { EmbeddingsClient } from "./embeddings-client.js";

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
  public readonly embedMany?: (texts: readonly string[]) => Promise<number[][]>;
  private readonly cache = new Map<string, Promise<number[]>>();

  public constructor(
    private readonly inner: EmbeddingsClient,
    private readonly maxEntries = 32,
  ) {
    this.modelId = inner.modelId;
    if (inner.embedMany) this.embedMany = inner.embedMany.bind(inner);
  }

  public embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) {
      this.cache.delete(text);
      this.cache.set(text, cached);
      return cached;
    }
    const pending = this.inner.embed(text);
    this.cache.set(text, pending);
    pending.catch(() => {
      if (this.cache.get(text) === pending) this.cache.delete(text);
    });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return pending;
  }
}
