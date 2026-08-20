import { z } from "zod";

import {
  ChatProviderError,
  chatSafetyGuard,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatResponseObserver,
  type ChatSource,
  type DroppedExchangeFact,
  type UserCustomizationAnalysisResult,
} from "../../application/chat/chat-provider.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "../../application/chat/tools/chat-tool.js";
import { buildChatContext, buildChatInstructions, chatModelJsonSchema, parseChatModelOutput } from "./chat-structured-output.js";
import {
  buildDroppedExchangeConsolidationPrompt,
  droppedExchangeConsolidationJsonSchema,
  parseDroppedExchangeConsolidationOutput,
} from "./dropped-exchange-consolidation.js";
import { ModelFallbackChain } from "./model-fallback-chain.js";
import {
  buildUserCustomizationAnalysisPrompt,
  parseUserCustomizationAnalysisOutput,
  userCustomizationAnalysisJsonSchema,
} from "./user-customization-analysis.js";

const responseSchema = z.object({
  output: z.array(z.object({
    type: z.string(),
    result: z.string().optional(),
    // function_call items only (custom tool calls) — Responses API item
    // shape: { type: "function_call", call_id, name, arguments }.
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
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
    input_tokens_details: z.object({
      cached_tokens: z.number().int().nonnegative().default(0),
    }).optional(),
    output_tokens_details: z.object({
      reasoning_tokens: z.number().int().nonnegative().default(0),
    }).optional(),
  }).optional(),
});

const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().nullable().optional(),
    type: z.string().optional(),
  }),
});

const streamEventSchema = z.object({
  type: z.string(),
  partial_image_b64: z.string().optional(),
  partial_image_index: z.number().int().nonnegative().optional(),
  response: z.unknown().optional(),
  error: z.object({
    code: z.string().nullable().optional(),
    type: z.string().optional(),
  }).optional(),
});

const maximumGeneratedImageBytes = 10 * 1024 * 1024;
const maximumGeneratedImagesPerReply = 4;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Bounds how many times a single reply can round-trip through the model to
// execute tool calls before forcing a final answer, so a model stuck calling
// tools in a loop can't run away on latency/cost.
const maxToolRoundTrips = 6;
const toolExecutionTimeoutMs = 10_000;
const toolBudgetExhaustedMessage = JSON.stringify({
  error: "Tool call budget exhausted. Do not call any more tools — answer now with what you already have, noting any gaps.",
});

interface FunctionCallOutputItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export class OpenAiResponsesChatProvider implements ChatProvider {
  private readonly modelChain: ModelFallbackChain;
  // Separate chain for the two standalone structured-output calls (own
  // prompt/schema, outside the main reply turn) — falls back to the primary
  // chain when the caller doesn't configure a cheaper summary model.
  private readonly summaryModelChain: ModelFallbackChain;

  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    models: readonly string[],
    private readonly generation: {
      reasoningEffort: "minimal" | "low" | "medium" | "high";
      verbosity: "low" | "medium" | "high";
      maxOutputTokens: number;
      summaryModels?: readonly string[];
    },
  ) {
    this.modelChain = new ModelFallbackChain(models);
    this.summaryModelChain = new ModelFallbackChain(generation.summaryModels ?? models);
  }

  public async reply(
    request: ChatRequest,
    observer?: ChatResponseObserver,
  ): Promise<ChatResponse> {
    const context = buildChatContext(request);
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: context },
      ...request.images.flatMap((image) => [
        {
          type: "input_text",
          text: image.source === "current_message"
            ? `CURRENT MESSAGE IMAGE ${image.sourceIndex + 1} (untrusted image input):`
            : `REPLY CHAIN IMAGE ${image.sourceIndex + 1} (untrusted image input):`,
        },
        { type: "input_image", image_url: image.dataUrl, detail: "auto" },
      ]),
    ];
    const customTools = request.enabledTools ?? [];
    const toolContext: ChatToolContext = {
      guildId: request.guildId,
      channelId: request.channelId,
      currentUser: request.currentUser,
      channelIsNsfw: request.channelIsNsfw ?? false,
      music: request.musicActor
        ? {
            actor: request.musicActor,
            volumeMaximum: request.musicVolumeMaximum ?? 150,
            musicControllerRoleIds: request.musicControllerRoleIds ?? new Set(),
            botAdministratorRoleIds: request.musicBotAdministratorRoleIds ?? new Set(),
          }
        : null,
    };
    let input: unknown[] = [{ role: "user", content }];
    // Only the first request can stream (for image-generation previews) — a
    // follow-up round-trip after a tool call is always a plain JSON request.
    let stream = request.imageGenerationEnabled && Boolean(observer);

    for (let roundTrip = 0; ; roundTrip++) {
      const body = await this.modelChain.run((model) =>
        this.postResponses(model, request, input, customTools, stream, observer));
      const parsed = responseSchema.parse(body);
      const functionCalls = parsed.output.filter((item): item is typeof item & FunctionCallOutputItem =>
        item.type === "function_call" && Boolean(item.call_id) && Boolean(item.name) && item.arguments !== undefined);

      if (functionCalls.length === 0) {
        return this.parseResponse(parsed, request);
      }

      if (roundTrip >= maxToolRoundTrips) {
        // Budget exhausted: rather than finalize on a response that's all
        // function_call items (which parseResponse can't turn into a real
        // reply and would just throw), tell the model it's out of tool
        // calls and force one last answer-only request with no tools
        // offered, so it has no choice but to produce a real message.
        const finalizeInput = [
          ...input,
          ...functionCalls.map((call) => ({
            type: "function_call",
            call_id: call.call_id,
            name: call.name,
            arguments: call.arguments,
          })),
          ...functionCalls.map((call) => ({
            type: "function_call_output",
            call_id: call.call_id,
            output: toolBudgetExhaustedMessage,
          })),
        ];
        const finalizeBody = await this.modelChain.run((model) =>
          this.postResponses(model, request, finalizeInput, [], false, observer));
        return this.parseResponse(responseSchema.parse(finalizeBody), request);
      }

      const results = await Promise.all(
        functionCalls.map(async (call) => ({
          call,
          result: await this.executeToolCall(call, customTools, toolContext),
        })),
      );
      input = [
        ...input,
        ...functionCalls.map((call) => ({
          type: "function_call",
          call_id: call.call_id,
          name: call.name,
          arguments: call.arguments,
        })),
        ...results.map(({ call, result }) => ({
          type: "function_call_output",
          call_id: call.call_id,
          output: result.content,
        })),
      ];
      stream = false;
    }
  }

  private async postResponses(
    model: string,
    request: ChatRequest,
    input: unknown[],
    customTools: readonly ChatTool[],
    stream: boolean,
    observer?: ChatResponseObserver,
  ): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: buildChatInstructions(request, chatSafetyGuard),
        input,
        reasoning: { effort: this.generation.reasoningEffort },
        text: {
          verbosity: this.generation.verbosity,
          format: { type: "json_schema", name: "persona_chat_response", strict: true, schema: chatModelJsonSchema },
        },
        max_output_tokens: this.generation.maxOutputTokens,
        tools: [
          ...(request.webSearchMode === "auto" ? [{ type: "web_search" }] : []),
          ...(request.imageGenerationEnabled
            ? [{ type: "image_generation", ...(stream ? { partial_images: 2 } : {}) }]
            : []),
          ...customTools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: true,
          })),
        ],
        tool_choice: request.webSearchMode === "auto" || request.imageGenerationEnabled || customTools.length > 0
          ? "auto"
          : undefined,
        stream: stream || undefined,
      }),
      signal: AbortSignal.timeout(stream ? 180_000 : 60_000),
    });
    if (!response.ok) {
      const errorBody: unknown = await response.json().catch(() => null);
      const parsedError = errorResponseSchema.safeParse(errorBody);
      const code = parsedError.success
        ? (parsedError.data.error.code ?? parsedError.data.error.type ?? null)
        : null;
      throw new ChatProviderError(
        `Chat provider returned HTTP ${response.status}${code ? ` (${code})` : ""}.`,
        response.status,
        code,
      );
    }
    return stream ? await this.readStream(response, observer!) : await response.json();
  }

  private async executeToolCall(
    call: FunctionCallOutputItem,
    tools: readonly ChatTool[],
    ctx: ChatToolContext,
  ): Promise<ChatToolResult> {
    const tool = tools.find((candidate) => candidate.name === call.name);
    if (!tool) return { content: `Unknown tool "${call.name}".` };
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      return { content: "Invalid tool arguments — could not parse as JSON." };
    }
    try {
      return await Promise.race([
        tool.execute(args, ctx),
        new Promise<ChatToolResult>((_, reject) => {
          setTimeout(() => reject(new Error("tool_timeout")), toolExecutionTimeoutMs);
        }),
      ]);
    } catch {
      return { content: "That tool failed to run right now — treat it as unavailable for this reply." };
    }
  }

  public async analyzeUserCustomization(rawText: string): Promise<UserCustomizationAnalysisResult> {
    const body = await this.summaryModelChain.run(async (model) => {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: buildUserCustomizationAnalysisPrompt(rawText),
          input: [{ role: "user", content: [{ type: "input_text", text: "Analyze the submitted text per the instructions." }] }],
          reasoning: { effort: this.generation.reasoningEffort },
          text: {
            verbosity: this.generation.verbosity,
            format: { type: "json_schema", name: "user_customization_analysis", strict: true, schema: userCustomizationAnalysisJsonSchema },
          },
          max_output_tokens: this.generation.maxOutputTokens,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const errorBody: unknown = await response.json().catch(() => null);
        const parsedError = errorResponseSchema.safeParse(errorBody);
        const code = parsedError.success
          ? (parsedError.data.error.code ?? parsedError.data.error.type ?? null)
          : null;
        throw new ChatProviderError(
          `Chat provider returned HTTP ${response.status}${code ? ` (${code})` : ""}.`,
          response.status,
          code,
        );
      }
      return response.json();
    });
    const parsed = responseSchema.parse(body);
    const texts: string[] = [];
    for (const item of parsed.output) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) texts.push(part.text);
      }
    }
    const analysis = parseUserCustomizationAnalysisOutput(texts.join("\n").trim());
    if (!analysis.ok) {
      return { ok: false, reason: analysis.reason ?? "That file couldn't be accepted as a customization." };
    }
    const markdown = analysis.cleanedMarkdown?.trim();
    if (!markdown) {
      return { ok: false, reason: "No usable style preferences were found in that file." };
    }
    return { ok: true, markdown };
  }

  public async summarizeDroppedExchanges(
    exchanges: readonly { user: string; assistant: string }[],
  ): Promise<readonly DroppedExchangeFact[]> {
    const body = await this.summaryModelChain.run(async (model) => {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: buildDroppedExchangeConsolidationPrompt(exchanges),
          input: [{ role: "user", content: [{ type: "input_text", text: "Extract facts per the instructions." }] }],
          reasoning: { effort: this.generation.reasoningEffort },
          text: {
            verbosity: this.generation.verbosity,
            format: { type: "json_schema", name: "dropped_exchange_consolidation", strict: true, schema: droppedExchangeConsolidationJsonSchema },
          },
          max_output_tokens: this.generation.maxOutputTokens,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const errorBody: unknown = await response.json().catch(() => null);
        const parsedError = errorResponseSchema.safeParse(errorBody);
        const code = parsedError.success
          ? (parsedError.data.error.code ?? parsedError.data.error.type ?? null)
          : null;
        throw new ChatProviderError(
          `Chat provider returned HTTP ${response.status}${code ? ` (${code})` : ""}.`,
          response.status,
          code,
        );
      }
      return response.json();
    });
    const parsed = responseSchema.parse(body);
    const texts: string[] = [];
    for (const item of parsed.output) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) texts.push(part.text);
      }
    }
    return parseDroppedExchangeConsolidationOutput(texts.join("\n").trim()).facts;
  }

  private async readStream(
    response: Response,
    observer: ChatResponseObserver,
  ): Promise<unknown> {
    if (!response.body) {
      throw new ChatProviderError("Chat provider returned an empty stream.", 502, "empty_stream");
    }
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completedResponse: unknown = null;

    const processBlock = async (block: string): Promise<void> => {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") return;
      const event = streamEventSchema.parse(JSON.parse(data));
      if (event.type === "response.image_generation_call.partial_image" && event.partial_image_b64) {
        const image = this.decodeGeneratedImage(
          event.partial_image_b64,
          `generated-preview-${(event.partial_image_index ?? 0) + 1}.png`,
        );
        if (image) await observer.onImagePreview(image);
      } else if (event.type === "response.completed" && event.response) {
        completedResponse = event.response;
      } else if (event.type === "error" || event.type === "response.failed") {
        const code = event.error?.code ?? event.error?.type ?? "stream_failed";
        throw new ChatProviderError(`Chat provider stream failed (${code}).`, 502, code);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) await processBlock(block);
      if (done) break;
    }
    if (buffer.trim()) await processBlock(buffer);
    if (!completedResponse) {
      throw new ChatProviderError("Chat provider stream ended before completion.", 502, "incomplete_stream");
    }
    return completedResponse;
  }

  private parseResponse(body: unknown, request: ChatRequest): ChatResponse {
    const parsed = responseSchema.parse(body);
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
    const modelOutput = parseChatModelOutput(texts.join("\n").trim());
    const generatedImages = parsed.output
      .filter((item) => item.type === "image_generation_call" && item.result)
      .slice(0, maximumGeneratedImagesPerReply)
      .map((item, index) => this.decodeGeneratedImage(
        item.result!,
        `generated-image-${index + 1}.png`,
      ))
      .filter((image) => image !== null);
    return {
      text: modelOutput.response,
      userMemoryActions: modelOutput.userMemoryActions,
      guildKnowledgeCandidates: modelOutput.guildKnowledgeCandidates,
      sources: [...sources.values()].slice(0, 5),
      usage: parsed.usage
        ? {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
            totalTokens: parsed.usage.total_tokens,
            cachedInputTokens: parsed.usage.input_tokens_details?.cached_tokens ?? null,
            reasoningTokens: parsed.usage.output_tokens_details?.reasoning_tokens ?? null,
          }
        : null,
      webSearchUsed: parsed.output.some((item) => item.type === "web_search_call"),
      generatedImages,
      ambientAction: modelOutput.ambientAction,
      reactionEmoji: modelOutput.reactionEmoji,
    };
  }

  private decodeGeneratedImage(encoded: string, filename: string): {
    data: Buffer;
    contentType: "image/png";
    filename: string;
  } | null {
    const data = Buffer.from(encoded, "base64");
    if (data.length === 0 || data.length > maximumGeneratedImageBytes) return null;
    if (!data.subarray(0, 8).equals(pngSignature)) return null;
    return { data, contentType: "image/png", filename };
  }
}
