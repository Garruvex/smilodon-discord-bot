// Port for whatever embeddings provider is configured (OpenAI, Gemini) — see
// infrastructure/chat/openai-embeddings-client.ts and gemini-embeddings-client.ts.
export interface EmbeddingsClient {
  // Identifies the exact provider+model+dimensionality producing vectors
  // from this instance — two clients with different values here can put
  // out vectors in incompatible semantic spaces even at the same array
  // length, so callers that cache embeddings (persona-bundle-compiler.ts)
  // must key reuse on this, not just on dimensionality. Required (not
  // optional) so a fingerprint mismatch can never silently degrade to
  // "unknown == unknown, treat as compatible" for a forgotten implementation.
  readonly modelId: string;
  embed(text: string): Promise<number[]>;
  embedMany?(texts: readonly string[]): Promise<number[][]>;
}
