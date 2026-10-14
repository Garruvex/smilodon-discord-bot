import type { StructuredCharacterProvider } from "../../application/chat/chat-provider.js";
import { z } from "zod";
const responseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) });
export class HttpDecisionProvider implements StructuredCharacterProvider {
  public constructor(private readonly configuration: { baseUrl: string; apiKey: string; model: string }) {}
  public async generateCharacterData(prompt: string, schema: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.configuration.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${this.configuration.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.configuration.model, messages: [{ role: "system", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "social_decision", strict: true, schema } } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Decision endpoint returned HTTP ${response.status}`);
    return JSON.parse(responseSchema.parse(await response.json()).choices[0]!.message.content) as unknown;
  }
}
