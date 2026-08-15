import { z } from "zod";

import { chatSafetyGuard, ChatProviderError, type ChatProvider, type ChatRequest, type ChatResponse } from "../../application/chat/chat-provider.js";

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }).optional(),
});

const errorResponseSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.string().nullable().optional(),
    type: z.string().optional(),
  }),
});

export class OpenAiCompatibleChatProvider implements ChatProvider {
  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  public async reply(request: ChatRequest): Promise<ChatResponse> {
    const context = request.referencedMessage
      ? `The user replied to this Discord message:\n${request.referencedMessage}\n\nTheir request:\n${request.message}`
      : request.message;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: `${request.personality}\n\n${chatSafetyGuard}` },
          { role: "user", content: `${request.userName}: ${context}` },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const parsed = errorResponseSchema.safeParse(body);
      const providerCode = parsed.success
        ? (parsed.data.error.code ?? parsed.data.error.type ?? null)
        : null;
      throw new ChatProviderError(
        `Chat provider returned HTTP ${response.status}${providerCode ? ` (${providerCode})` : ""}.`,
        response.status,
        providerCode,
      );
    }
    const parsed = responseSchema.parse(await response.json());
    return {
      text: parsed.choices[0]!.message.content.trim(),
      sources: [],
      usage: parsed.usage
        ? {
            inputTokens: parsed.usage.prompt_tokens,
            outputTokens: parsed.usage.completion_tokens,
            totalTokens: parsed.usage.total_tokens,
          }
        : null,
      webSearchUsed: false,
    };
  }
}
