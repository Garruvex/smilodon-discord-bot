import { z } from "zod";

import { chatSafetyGuard, ChatProviderError, type ChatProvider, type ChatRequest, type ChatResponse } from "../../application/chat/chat-provider.js";
import { buildChatContext, buildChatInstructions, chatModelJsonSchema, parseChatModelOutput } from "./chat-structured-output.js";

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
    const userContent = buildChatContext(request);
    const userMessage = request.images.length > 0
      ? {
          role: "user",
          content: [
            { type: "text", text: userContent },
            ...request.images.map((image) => ({
              type: "image_url",
              image_url: { url: image.dataUrl },
            })),
          ],
        }
      : { role: "user", content: userContent };
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: buildChatInstructions(request, chatSafetyGuard) },
          userMessage,
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "persona_chat_response", strict: true, schema: chatModelJsonSchema },
        },
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
    const modelOutput = parseChatModelOutput(parsed.choices[0]!.message.content);
    return {
      text: modelOutput.response,
      userMemoryActions: modelOutput.userMemoryActions,
      guildKnowledgeCandidates: modelOutput.guildKnowledgeCandidates,
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
