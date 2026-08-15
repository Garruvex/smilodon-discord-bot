import { z } from "zod";

import {
  ChatProviderError,
  chatSafetyGuard,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatSource,
} from "../../application/chat/chat-provider.js";

const responseSchema = z.object({
  output: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
      annotations: z.array(z.object({
        type: z.string(),
        url: z.string().url().optional(),
        title: z.string().optional(),
      }).passthrough()).optional(),
    }).passthrough()).optional(),
  }).passthrough()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }).optional(),
});

const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().nullable().optional(),
    type: z.string().optional(),
  }),
});

export class OpenAiResponsesChatProvider implements ChatProvider {
  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  public async reply(request: ChatRequest): Promise<ChatResponse> {
    const context = request.referencedMessage
      ? `The user replied to this Discord message:\n${request.referencedMessage}\n\nTheir request:\n${request.message}`
      : request.message;
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: `${request.userName}: ${context}` },
      ...request.images.map((image) => ({
        type: "input_image",
        image_url: image.dataUrl,
        detail: "auto",
      })),
    ];
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        instructions: `${request.personality}\n\n${chatSafetyGuard}`,
        input: [{ role: "user", content }],
        tools: request.webSearchEnabled ? [{ type: "web_search" }] : [],
        tool_choice: request.webSearchEnabled ? "auto" : undefined,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const parsed = errorResponseSchema.safeParse(body);
      const code = parsed.success
        ? (parsed.data.error.code ?? parsed.data.error.type ?? null)
        : null;
      throw new ChatProviderError(
        `Chat provider returned HTTP ${response.status}${code ? ` (${code})` : ""}.`,
        response.status,
        code,
      );
    }

    const parsed = responseSchema.parse(await response.json());
    const texts: string[] = [];
    const sources = new Map<string, ChatSource>();
    for (const item of parsed.output) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) texts.push(part.text);
        if (!request.includeSources) continue;
        for (const annotation of part.annotations ?? []) {
          if (annotation.type !== "url_citation" || !annotation.url) continue;
          sources.set(annotation.url, {
            title: annotation.title?.trim() || new URL(annotation.url).hostname,
            url: annotation.url,
          });
        }
      }
    }
    return {
      text: texts.join("\n").trim(),
      sources: [...sources.values()].slice(0, 5),
      usage: parsed.usage
        ? {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
            totalTokens: parsed.usage.total_tokens,
          }
        : null,
      webSearchUsed: parsed.output.some((item) => item.type === "web_search_call"),
    };
  }
}
