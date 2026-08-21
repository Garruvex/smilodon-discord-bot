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
import type { ChannelSummaryFact, ChannelSummaryMessage } from "../../application/context/channel-message-summarizer.js";
import {
  channelMessageSummaryMaxOutputTokens,
  channelMessageSummaryJsonSchema,
  prepareChannelMessageSummary,
} from "./channel-message-summarization.js";
import { buildChatContext, buildChatInstructions, chatModelJsonSchema, parseChatModelOutput } from "./chat-structured-output.js";
import { ModelFallbackChain } from "./model-fallback-chain.js";
import {
  buildUserCustomizationAnalysisPrompt,
  parseUserCustomizationAnalysisOutput,
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
  private readonly modelChain: ModelFallbackChain;
  // Separate chain for the standalone analyzeUserCustomization call — falls
  // back to the primary chain when the caller doesn't configure a cheaper
  // summary model.
  private readonly summaryModelChain: ModelFallbackChain;

  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    models: readonly string[],
    summaryModels: readonly string[] | null,
    private readonly logger?: Logger,
    private readonly summaryMaxOutputTokens = channelMessageSummaryMaxOutputTokens,
  ) {
    this.modelChain = new ModelFallbackChain(models);
    this.summaryModelChain = new ModelFallbackChain(summaryModels ?? models);
  }

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
    const body = await this.modelChain.run(async (model) => {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
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
        const errorBody: unknown = await response.json().catch(() => null);
        const parsedError = errorResponseSchema.safeParse(errorBody);
        const providerCode = parsedError.success
          ? (parsedError.data.error.code ?? parsedError.data.error.type ?? null)
          : null;
        throw new ChatProviderError(
          `Chat provider returned HTTP ${response.status}${providerCode ? ` (${providerCode})` : ""}.`,
          response.status,
          providerCode,
        );
      }
      return response.json();
    });
    const parsed = responseSchema.parse(body);
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
    const body = await this.summaryModelChain.run(async (model) => {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: buildUserCustomizationAnalysisPrompt(rawText) }],
          response_format: {
            type: "json_schema",
            json_schema: { name: "user_customization_analysis", strict: true, schema: userCustomizationAnalysisJsonSchema },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const errorBody: unknown = await response.json().catch(() => null);
        const parsedError = errorResponseSchema.safeParse(errorBody);
        const providerCode = parsedError.success
          ? (parsedError.data.error.code ?? parsedError.data.error.type ?? null)
          : null;
        throw new ChatProviderError(
          `Chat provider returned HTTP ${response.status}${providerCode ? ` (${providerCode})` : ""}.`,
          response.status,
          providerCode,
        );
      }
      return response.json();
    });
    const parsed = responseSchema.parse(body);
    const analysis = parseUserCustomizationAnalysisOutput(parsed.choices[0]!.message.content);
    if (!analysis.ok) {
      return { ok: false, reason: analysis.reason ?? "That file couldn't be accepted as a customization." };
    }
    const markdown = analysis.cleanedMarkdown?.trim();
    if (!markdown) {
      return { ok: false, reason: "No usable style preferences were found in that file." };
    }
    return { ok: true, markdown };
  }

  public async summarizeChannelMessages(
    guildId: string,
    messages: readonly ChannelSummaryMessage[],
  ): Promise<readonly ChannelSummaryFact[]> {
    const summary = prepareChannelMessageSummary(guildId, messages);
    const body = await this.summaryModelChain.run(async (model) => {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: summary.prompt }],
          response_format: {
            type: "json_schema",
            json_schema: { name: "channel_message_summary", strict: true, schema: channelMessageSummaryJsonSchema },
          },
          max_tokens: this.summaryMaxOutputTokens,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const errorBody: unknown = await response.json().catch(() => null);
        const parsedError = errorResponseSchema.safeParse(errorBody);
        const providerCode = parsedError.success
          ? (parsedError.data.error.code ?? parsedError.data.error.type ?? null)
          : null;
        throw new ChatProviderError(
          `Chat provider returned HTTP ${response.status}${providerCode ? ` (${providerCode})` : ""}.`,
          response.status,
          providerCode,
        );
      }
      return response.json();
    });
    const parsed = responseSchema.parse(body);
    return summary.parse(parsed.choices[0]!.message.content).facts;
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
    if (request.enabledTools && request.enabledTools.length > 0) unsupported.push("toolCallingEnabled");
    if (unsupported.length === 0) return;
    this.warnedGuilds.add(request.guildId);
    this.logger.warn(
      { guildId: request.guildId, unsupported },
      "Guild has chat features enabled that the chat_completions provider mode does not support; they will have no effect",
    );
  }
}
