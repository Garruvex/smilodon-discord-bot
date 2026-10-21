import type { EmbeddingCallOptions, EmbeddingsClient } from "../chat/embeddings-client.js";
import { consumeEmbeddingOperation } from "./approved-model-operation.js";

// This facade belongs outside all caches, including in-flight deduplication.
export function guardEmbeddingTransport(provider: EmbeddingsClient): EmbeddingsClient {
  const embed = async (text: string, options?: EmbeddingCallOptions): Promise<number[]> => {
    const attempt = consumeEmbeddingOperation(false, [text], options);
    await attempt.options.beforeAttempt!();
    const result = await provider.embed(text, attempt.options);
    await attempt.options.beforeAttempt!(); return result;
  };
  const embedMany = provider.embedMany?.bind(provider);
  return Object.freeze({ modelId: provider.modelId, embed, ...(embedMany ? {
    embedMany: async (texts: readonly string[], options?: EmbeddingCallOptions): Promise<number[][]> => {
      const copy = [...texts]; const attempt = consumeEmbeddingOperation(true, copy, options);
      try {
        await attempt.options.beforeAttempt!(); const result = await embedMany(copy, attempt.options);
        await attempt.options.beforeAttempt!();
        if (result.length !== copy.length) throw new Error("Embedding batch length mismatch.");
        return result;
      } catch (error) { attempt.failed(); throw error; }
    },
  } : {}) });
}
