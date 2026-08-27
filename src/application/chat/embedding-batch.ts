import type { EmbeddingsClient } from "./embeddings-client.js";
import { mapWithConcurrency } from "../concurrency/map-with-concurrency.js";

// Embedding inputs are limited individually, and OpenAI also caps aggregate
// tokens per request. 32 inputs remains below that aggregate ceiling even if
// every input is at its individual maximum.
export const embeddingBatchSize = 32;
const fallbackConcurrency = 8;

async function embedIndividually(
  texts: readonly string[],
  client: EmbeddingsClient,
): Promise<(number[] | null)[]> {
  return mapWithConcurrency(
    texts,
    fallbackConcurrency,
    (text) => client.embed(text).catch(() => null),
  );
}

export async function embedTextsBestEffort(
  texts: readonly string[],
  client: EmbeddingsClient,
): Promise<(number[] | null)[]> {
  if (!client.embedMany) return embedIndividually(texts, client);

  const embeddings: (number[] | null)[] = [];
  for (let offset = 0; offset < texts.length; offset += embeddingBatchSize) {
    const batch = texts.slice(offset, offset + embeddingBatchSize);
    try {
      const batchEmbeddings = await client.embedMany(batch);
      if (batchEmbeddings.length !== batch.length) throw new Error("Embedding batch length mismatch.");
      embeddings.push(...batchEmbeddings);
    } catch {
      // A single oversized or otherwise invalid input can reject its whole
      // batch. Recover the other inputs with the existing per-item behavior.
      embeddings.push(...await embedIndividually(batch, client));
    }
  }
  return embeddings;
}
