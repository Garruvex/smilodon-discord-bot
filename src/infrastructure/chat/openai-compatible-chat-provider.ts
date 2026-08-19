import type { Logger } from "pino";
import { z } from "zod";

import {
  chatSafetyGuard,
  ChatProviderError,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type UserCustomizationAnalysisResult,
} from "../../application/chat/chat-provider.js";
import { buildChatContext, buildChatInstructions, chatModelJsonSchema, parseChatModelOutput } from "./chat-structured-output.js";
import {
  buildUserCustomizationAnalysisPrompt,
  parseUserCustomizationAnalysisOutput,
  renderUserCustomizationMarkdown,
  userCustomizationAnalysisJsonSchema,
} from "./user-customization-analysis.js";

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
  private readonly warnedGuilds = new Set<string>();

  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly logger?: Logger,
  ) {}

  public async reply(request: ChatRequest): Promise<ChatResponse> {
    this.warnUnsupportedConfig(request);
    const userContent = buildChatContext(request);
    const userMessage = request.images.length > 0
      ? {
          role: "user",
          content: [
            { type: "text", text: userContent },
            ...request.images.flatMap((image) => [
              {
                type: "text",
                text: image.source === "current_message"
                  ? `CURRENT MESSAGE IMAGE ${image.sourceIndex + 1} (untrusted image input):`
                  : `REPLY CHAIN IMAGE ${image.sourceIndex + 1} (untrusted image input):`,
              },
              { type: "image_url", image_url: { url: image.dataUrl } },
            ]),
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
            cachedInputTokens: null,
            reasoningTokens: null,
          }
        : null,
      webSearchUsed: false,
      generatedImages: [],
      ambientAction: modelOutput.ambientAction,
      reactionEmoji: modelOutput.reactionEmoji,
    };
  }

  public async analyzeUserCustomization(rawText: string): Promise<UserCustomizationAnalysisResult> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "system", content: buildUserCustomizationAnalysisPrompt(rawText) }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "user_customization_analysis", strict: true, schema: userCustomizationAnalysisJsonSchema },
        },
      }),
      signal: AbortSignal.timeout(30_000),
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
    const analysis = parseUserCustomizationAnalysisOutput(parsed.choices[0]!.message.content);
    if (!analysis.ok) {
      return { ok: false, reason: analysis.reason ?? "That file couldn't be accepted as a customization." };
    }
    const markdown = renderUserCustomizationMarkdown(analysis);
    if (!markdown) {
      return { ok: false, reason: "No usable style preferences were found in that file." };
    }
    return { ok: true, markdown };
  }

  // The chat_completions API this provider targets has no equivalent for web
  // search or image generation, so guild toggles for them are silently inert
  // here. Warn once per guild (per process) instead of failing, since admins
  // configure these per-guild without knowing which backend mode is active.
  private warnUnsupportedConfig(request: ChatRequest): void {
    if (!this.logger || this.warnedGuilds.has(request.guildId)) return;
    const unsupported: string[] = [];
    if (request.webSearchMode !== "off") unsupported.push("webSearchMode");
    if (request.imageGenerationEnabled) unsupported.push("imageGenerationEnabled");
    if (unsupported.length === 0) return;
    this.warnedGuilds.add(request.guildId);
    this.logger.warn(
      { guildId: request.guildId, unsupported },
      "Guild has chat features enabled that the chat_completions provider mode does not support; they will have no effect",
    );
  }
}
