import { z } from "zod";

const embeddingsResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })).min(1),
});

export interface EmbeddingsClient {
  embed(text: string): Promise<number[]>;
}

export class OpenAiEmbeddingsClient implements EmbeddingsClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  public async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Embeddings provider returned HTTP ${response.status}.`);
    }
    const parsed = embeddingsResponseSchema.parse(await response.json());
    return parsed.data[0]!.embedding;
  }
}
