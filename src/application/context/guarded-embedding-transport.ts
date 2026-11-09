import type { EmbeddingCallOptions, EmbeddingsClient } from "../chat/embeddings-client.js";
import { consumeEmbeddingOperation } from "./approved-model-operation.js";
import { checkModelAdmission } from "./model-admission-diagnostics.js";
import type { DiagnosticLogger } from "../diagnostics/chat-diagnostics.js";

// This facade belongs outside all caches, including in-flight deduplication.
export function guardEmbeddingTransport(provider: EmbeddingsClient, logger: DiagnosticLogger | null = null): EmbeddingsClient {
  const embed = async (text: string, options?: EmbeddingCallOptions): Promise<number[]> => {
    const attempt = await checkModelAdmission(logger, "embed", "approval", () => consumeEmbeddingOperation(false, [text], options));
    const beforeAttempt = (): Promise<void> => checkModelAdmission(logger, "embed", "source", () => attempt.options.beforeAttempt!());
    await beforeAttempt();
    const result = await provider.embed(text, { ...attempt.options, beforeAttempt });
    await checkModelAdmission(logger, "embed", "result", () => attempt.options.beforeAttempt!()); return result;
  };
  const embedMany = provider.embedMany?.bind(provider);
  return Object.freeze({ modelId: provider.modelId, embed, ...(embedMany ? {
    embedMany: async (texts: readonly string[], options?: EmbeddingCallOptions): Promise<number[][]> => {
      const copy = [...texts]; const attempt = await checkModelAdmission(logger, "embedMany", "approval", () => consumeEmbeddingOperation(true, copy, options));
      const beforeAttempt = (): Promise<void> => checkModelAdmission(logger, "embedMany", "source", () => attempt.options.beforeAttempt!());
      try {
        await beforeAttempt(); const result = await embedMany(copy, { ...attempt.options, beforeAttempt });
        await checkModelAdmission(logger, "embedMany", "result", () => attempt.options.beforeAttempt!());
        if (result.length !== copy.length) throw new Error("Embedding batch length mismatch.");
        return result;
      } catch (error) { attempt.failed(); throw error; }
    },
  } : {}) });
}
