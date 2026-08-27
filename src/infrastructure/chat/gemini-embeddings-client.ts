import { GoogleGenAI } from "@google/genai";

import type { EmbeddingsClient } from "../../application/chat/embeddings-client.js";

export class GeminiEmbeddingsClient implements EmbeddingsClient {
  private readonly client: GoogleGenAI;

  // outputDimensionality is required, not optional, deliberately — without
  // it, Gemini's MRL models return their own native size (gemini-embedding-
  // 001 defaults to 3072; text-embedding-004 to 768), which won't match the
  // fixed-width pgvector column every embedding-consuming table uses (see
  // embeddingDimensions in schema.ts) and either errors outright on insert
  // (Postgres) or silently produces useless zero-similarity comparisons
  // (SQLite, where cosineSimilarity returns 0 on a dimension mismatch
  // instead of throwing). Callers should pass schema.ts's
  // embeddingDimensions here, not invent a separate value.
  //
  // Only a model whose NATIVE dimensionality is >= the requested value can
  // actually honor this — MRL truncates down, it can't pad up. That rules
  // out text-embedding-004 (native/max 768) for this app's 1536-wide
  // column entirely; gemini-embedding-001 (native 3072) is the only current
  // Gemini option that can satisfy embeddingDimensions=1536.
  public constructor(
    apiKey: string,
    private readonly model: string,
    private readonly outputDimensionality: number,
    client?: GoogleGenAI,
  ) {
    this.client = client ?? new GoogleGenAI({ apiKey });
  }

  public async embed(text: string): Promise<number[]> {
    return (await this.embedMany([text]))[0]!;
  }

  public async embedMany(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.client.models.embedContent({
      model: this.model,
      // Separate Content objects produce separate vectors in input order;
      // multiple parts inside one Content would produce one aggregate vector.
      contents: texts.map((text) => ({ parts: [{ text }] })),
      config: {
        taskType: "SEMANTIC_SIMILARITY",
        outputDimensionality: this.outputDimensionality,
        abortSignal: AbortSignal.timeout(15_000),
      },
    });
    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== texts.length || embeddings.some((embedding) => !embedding.values)) {
      throw new Error("Gemini embeddings provider returned an incomplete batch.");
    }
    return embeddings.map((embedding) => embedding.values!);
  }
}
