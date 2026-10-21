import { reportStructuredUsage, type StructuredCallOptions } from "../../application/chat/chat-provider.js";
import type { StructuredCharacterProvider } from "../../application/chat/chat-provider.js";
import { ChatProviderError } from "../../application/chat/chat-provider.js";
import { z } from "zod";
const responseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }).optional().catch(undefined) });
export class HttpDecisionProvider implements StructuredCharacterProvider {
  public constructor(private readonly configuration: { baseUrl: string; apiKey: string; model: string }) {}
  public async generateCharacterData(prompt: string, schema: Record<string, unknown>, options?: StructuredCallOptions): Promise<unknown> {
    const response = await fetch(`${this.configuration.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${this.configuration.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.configuration.model, messages: [{ role: "system", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "social_decision", strict: true, schema } } }),
      signal: options?.signal ?? AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new ChatProviderError(`Decision endpoint returned HTTP ${response.status}`, response.status, null);
    const body = responseSchema.parse(await response.json());
    if (body.usage) reportStructuredUsage(options, { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens,
      totalTokens: body.usage.total_tokens, cachedInputTokens: null, reasoningTokens: null });
    return JSON.parse(body.choices[0]!.message.content) as unknown;
  }
}
