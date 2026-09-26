import { z } from "zod";

import type {
  StructuredModelClient,
  StructuredModelRequest,
  StructuredModelResponse,
} from "../../../application/campaign/ports/structured-model-client.js";
import { ChatProviderError } from "../../../application/chat/chat-provider.js";
import { ModelFallbackChain } from "../../chat/model-fallback-chain.js";
import { providerError } from "./http-error.js";

const responseSchema = z.object({
  status: z.string().optional(),
  output: z.array(
    z
      .object({
        type: z.string(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
      })
      .passthrough(),
  ),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      input_tokens_details: z.object({ cached_tokens: z.number().default(0) }).optional(),
    })
    .optional(),
});

export interface OpenAiResponsesClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly string[];
  // Sent only when set: non-reasoning models reject the parameter.
  readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export class OpenAiResponsesStructuredClient implements StructuredModelClient {
  public readonly name = "openai-responses";
  private readonly chain: ModelFallbackChain;

  public constructor(private readonly options: OpenAiResponsesClientOptions) {
    this.chain = new ModelFallbackChain(options.models);
  }

  public generate(request: StructuredModelRequest): Promise<StructuredModelResponse> {
    return this.chain.run(async (model) => {
      const response = await fetch(`${this.options.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          instructions: request.system,
          input: [{ role: "user", content: [{ type: "input_text", text: request.user }] }],
          ...(this.options.reasoningEffort === undefined ? {} : { reasoning: { effort: this.options.reasoningEffort } }),
          text: { format: { type: "json_schema", name: request.schemaName, strict: true, schema: request.jsonSchema } },
          max_output_tokens: request.maxOutputTokens,
        }),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      if (!response.ok) throw await providerError(response);
      const body = responseSchema.parse(await response.json());
      if (body.status === "incomplete") {
        throw new ChatProviderError("The model stopped before finishing.", 502, "incomplete_response");
      }
      const text = body.output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .flatMap((part) => (part.type === "output_text" && part.text !== undefined ? [part.text] : []))
        .join("")
        .trim();
      const usage = body.usage;
      return {
        text,
        model,
        usage:
          usage === undefined
            ? null
            : {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
              },
      };
    });
  }
}
