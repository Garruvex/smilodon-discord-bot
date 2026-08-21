import { GoogleGenAI } from "@google/genai";

import type { EmbeddingsClient } from "./openai-embeddings-client.js";

export class GeminiEmbeddingsClient implements EmbeddingsClient {
  private readonly client: GoogleGenAI;

  public constructor(
    apiKey: string,
    private readonly model: string,
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
