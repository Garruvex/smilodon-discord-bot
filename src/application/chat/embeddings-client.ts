// Port for whatever embeddings provider is configured (OpenAI, Gemini) — see
// infrastructure/chat/openai-embeddings-client.ts and gemini-embeddings-client.ts.
export interface EmbeddingsClient {
  embed(text: string): Promise<number[]>;
  embedMany?(texts: readonly string[]): Promise<number[][]>;
}
