import type { EmbeddingsClient, EmbeddingCallOptions } from "./embeddings-client.js";
import { SocialOutputSuppressed } from "./message-origin-store.js";
import { mapWithConcurrency } from "../concurrency/map-with-concurrency.js";

// Embedding inputs are limited individually, and OpenAI also caps aggregate
// tokens per request. 32 inputs remains below that aggregate ceiling even if
// every input is at its individual maximum.
export const embeddingBatchSize = 32;
const fallbackConcurrency = 8;

async function embedIndividually(
  texts: readonly string[],
  client: EmbeddingsClient,
  options?: EmbeddingCallOptions,
): Promise<(number[] | null)[]> {
  return mapWithConcurrency(
    texts,
    fallbackConcurrency,
    async (text) => { await options?.beforeAttempt?.();
      try { const result = await (options ? client.embed(text, options) : client.embed(text)); await options?.beforeAttempt?.(); return result; }
      catch (error) { if (error instanceof SocialOutputSuppressed || options?.signal?.aborted) throw error; return null; }
    },
  );
}

export async function embedTextsBestEffort(
  texts: readonly string[],
  client: EmbeddingsClient,
  options?: EmbeddingCallOptions,
): Promise<(number[] | null)[]> {
  await options?.beforeAttempt?.();
  if (!client.embedMany) return embedIndividually(texts, client, options);

  const embeddings: (number[] | null)[] = [];
  for (let offset = 0; offset < texts.length; offset += embeddingBatchSize) {
    const batch = texts.slice(offset, offset + embeddingBatchSize);
    try {
      await options?.beforeAttempt?.();
      const batchEmbeddings = await (options ? client.embedMany(batch, options) : client.embedMany(batch));
      await options?.beforeAttempt?.();
      if (batchEmbeddings.length !== batch.length) throw new Error("Embedding batch length mismatch.");
      embeddings.push(...batchEmbeddings);
    } catch (error) {
      if (error instanceof SocialOutputSuppressed || options?.signal?.aborted) throw error;
      // A single oversized or otherwise invalid input can reject its whole
      // batch. Recover the other inputs with the existing per-item behavior.
      embeddings.push(...await embedIndividually(batch, client, options));
    }
  }
  return embeddings;
}
