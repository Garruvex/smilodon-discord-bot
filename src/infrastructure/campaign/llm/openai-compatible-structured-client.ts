import { z } from "zod";

import type {
  StructuredModelClient,
  StructuredModelRequest,
  StructuredModelResponse,
} from "../../../application/campaign/ports/structured-model-client.js";
import { ModelFallbackChain } from "../../chat/model-fallback-chain.js";
import { providerError } from "./http-error.js";

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().default(0) }).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export interface OpenAiCompatibleClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly string[];
}

// Chat Completions with json_schema output, for OpenAI-compatible servers.
export class OpenAiCompatibleStructuredClient implements StructuredModelClient {
  public readonly name = "openai-compatible";
  private readonly chain: ModelFallbackChain;

  public constructor(private readonly options: OpenAiCompatibleClientOptions) {
    this.chain = new ModelFallbackChain(options.models);
  }

  public generate(request: StructuredModelRequest): Promise<StructuredModelResponse> {
    return this.chain.run(async (model) => {
      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          response_format: { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema: request.jsonSchema } },
          max_tokens: request.maxOutputTokens,
        }),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      if (!response.ok) throw await providerError(response);
      const body = responseSchema.parse(await response.json());
      const usage = body.usage ?? null;
      return {
        text: (body.choices[0]?.message.content ?? "").trim(),
        model,
        usage:
          usage === null
            ? null
            : {
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
                cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
              },
      };
    });
  }
}
