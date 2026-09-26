// One structured model call, provider-neutral. Campaign prompts, schemas,
// and parsing live in the application (dm/llm-*.ts); each provider adapter
// only transports the request. The stable context goes in `system` so the
// provider's prompt cache can reuse it across calls.
export interface StructuredModelRequest {
  readonly system: string;
  readonly user: string;
  readonly schemaName: string;
  // Strict-mode JSON schema: every property required, no extra properties.
  readonly jsonSchema: Record<string, unknown>;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

export interface StructuredModelResponse {
  // The raw JSON text; the caller parses and validates it.
  readonly text: string;
  readonly model: string;
  readonly usage: ModelUsage | null;
}

export interface StructuredModelClient {
  readonly name: string;
  generate(request: StructuredModelRequest): Promise<StructuredModelResponse>;
}
