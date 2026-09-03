import { z } from "zod";

import type { EmbeddingsClient } from "../../application/chat/embeddings-client.js";

const embeddingsResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) })).min(1),
});

export class OpenAiEmbeddingsClient implements EmbeddingsClient {
  public readonly modelId: string;

  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    // Includes baseUrl, not just the model name — two OpenAI-compatible
    // deployments (e.g. switching from OpenAI itself to a self-hosted or
    // third-party compatible endpoint) can serve the same model name with
    // different underlying weights/versions, which would otherwise let a
    // cached vector from one survive a switch to the other.
    this.modelId = `openai:${baseUrl}:${model}`;
  }

  public async embed(text: string): Promise<number[]> {
    return (await this.request(text, 1))[0]!;
  }

  public async embedMany(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.request(texts, texts.length);
  }

  private async request(input: string | readonly string[], expectedCount: number): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Embeddings provider returned HTTP ${response.status}.`);
    }
    const parsed = embeddingsResponseSchema.parse(await response.json());
    const embeddings: Array<number[] | undefined> = Array.from({ length: expectedCount }, () => undefined);
    for (const item of parsed.data) {
      if (item.index >= expectedCount || embeddings[item.index] !== undefined) {
        throw new Error("Embeddings provider returned invalid indexes.");
      }
      embeddings[item.index] = item.embedding;
    }
    if (embeddings.some((embedding) => embedding === undefined)) {
      throw new Error("Embeddings provider returned an incomplete batch.");
    }
    return embeddings.map((embedding) => embedding!);
  }
}
