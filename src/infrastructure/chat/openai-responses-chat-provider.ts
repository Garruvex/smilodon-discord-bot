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
import type { ChannelSummaryMessage, ChannelSummaryResult } from "../../application/context/channel-message-summarizer.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "../../application/chat/tools/chat-tool.js";
import { buildChatContext, buildChatInstructions, chatModelJsonSchema, parseChatModelOutput } from "./chat-structured-output.js";
import {
  channelMessageSummaryMaxOutputTokens,
  channelMessageSummaryJsonSchema,
  prepareChannelMessageSummary,
} from "../../application/chat/channel-message-summarization.js";
import {
  buildDroppedExchangeConsolidationPrompt,
  droppedExchangeConsolidationJsonSchema,
  parseDroppedExchangeConsolidationOutput,
} from "../../application/chat/dropped-exchange-consolidation.js";
import {
  buildMemoryConflictClassificationPrompt,
  memoryConflictClassificationJsonSchema,
  parseMemoryConflictClassificationOutput,
} from "../../application/chat/memory-conflict-classification.js";
import {
  buildReplyChainOverflowSummaryPrompt,
  replyChainOverflowSummaryJsonSchema,
  parseReplyChainOverflowSummaryOutput,
} from "../../application/chat/reply-chain-overflow-summary.js";
import { ModelFallbackChain } from "./model-fallback-chain.js";
import {
  buildPersonaBundleCompilationPrompt,
  personaBundleCompilationJsonSchema,
  personaBundleCompilationMaxOutputTokens,
  personaBundleCompilationTimeoutMs,
  parsePersonaBundleSectionSelection,
} from "../../application/chat/persona-bundle-compilation.js";
import {
  buildPersonaDriftEvolutionPrompt,
  personaDriftEvolutionJsonSchema,
  parsePersonaDriftEvolutionOutput,
} from "../../application/chat/persona-drift-evolution.js";
import {
  buildUserCustomizationAnalysisPrompt,
  parseUserCustomizationAnalysisOutput,
  userCustomizationAnalysisJsonSchema,
} from "../../application/chat/user-customization-analysis.js";

const responseSchema = z.object({
  status: z.enum(["completed", "failed", "in_progress", "cancelled", "queued", "incomplete"]).optional(),
  incomplete_details: z.object({ reason: z.string() }).nullable().optional(),
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
      summaryMaxOutputTokens?: number;
      summaryReasoningEffort?: "minimal" | "low" | "medium" | "high";
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
      isOwner: request.isOwner ?? false,
      music: request.musicActor
        ? {
            actor: request.musicActor,
            resolveAccessSubjectFields: request.musicResolveAccessSubjectFields
              ?? ((): { roleIds: readonly string[]; memberPermissions: bigint; botPermissions: bigint | null } =>
                ({ roleIds: [], memberPermissions: 0n, botPermissions: null })),
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

      // Sequential, not Promise.all: several tools (music playback chief
      // among them — see ChatToolContext.music) are stateful, and the model
      // emits function calls in the order it expects them applied (e.g.
      // skip_track then pause). Running them concurrently would let a
      // slower earlier call finish after a later one, applying them out of
      // the order the model intended and racing on shared playback state.
      const results: { call: FunctionCallOutputItem; result: ChatToolResult }[] = [];
      for (const call of functionCalls) {
        results.push({ call, result: await this.executeToolCall(call, customTools, toolContext) });
      }
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
    // Racing a timer can't actually cancel tool.execute() — the loser keeps
    // running after this returns. The AbortController at least lets a
    // side-effecting tool (see ChatToolContext.signal) notice and bail out
    // right before it would otherwise mutate anything.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), toolExecutionTimeoutMs);
    try {
      return await Promise.race([
        tool.execute(args, { ...ctx, signal: timeoutController.signal }),
        new Promise<ChatToolResult>((_, reject) => {
          timeoutController.signal.addEventListener("abort", () => reject(new Error("tool_timeout")));
        }),
      ]);
    } catch {
      return { content: "That tool failed to run right now — treat it as unavailable for this reply." };
    } finally {
      clearTimeout(timer);
    }
  }

  // Shared by every standalone structured-output capability below (own
  // prompt/schema, outside the main reply turn) — factors out the fetch/
  // error-handling/text-extraction boilerplate each one used to repeat, the
  // same way Gemini's generateStructured already does for that provider.
  // Deliberately NOT used by summarizeChannelMessages: that method's
  // model-fallback retry has to wrap schema *validation* too (a fact-parse
  // failure should try the next model, not just an HTTP failure), whereas
  // every method here only retries the raw call and parses after — a real
  // behavioral difference, not just unfactored duplication.
  private async callStructuredOutput(
    instructions: string,
    schemaName: string,
    jsonSchema: object,
    options?: { maxOutputTokens?: number; timeoutMs?: number },
  ): Promise<string> {
    const body = await this.summaryModelChain.run(async (model) => {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions,
          input: [{ role: "user", content: [{ type: "input_text", text: "Follow the instructions." }] }],
          reasoning: { effort: this.generation.reasoningEffort },
          text: {
            verbosity: this.generation.verbosity,
            format: { type: "json_schema", name: schemaName, strict: true, schema: jsonSchema },
          },
          max_output_tokens: options?.maxOutputTokens ?? this.generation.maxOutputTokens,
        }),
        signal: AbortSignal.timeout(options?.timeoutMs ?? 30_000),
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
    return texts.join("\n").trim();
  }

  public async analyzeUserCustomization(rawText: string): Promise<UserCustomizationAnalysisResult> {
    const text = await this.callStructuredOutput(
      buildUserCustomizationAnalysisPrompt(rawText),
      "user_customization_analysis",
      userCustomizationAnalysisJsonSchema,
    );
    const analysis = parseUserCustomizationAnalysisOutput(text);
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
    speaker: { id: string; displayName: string },
  ): Promise<readonly DroppedExchangeFact[]> {
    const text = await this.callStructuredOutput(
      buildDroppedExchangeConsolidationPrompt(exchanges, speaker),
      "dropped_exchange_consolidation",
      droppedExchangeConsolidationJsonSchema,
    );
    return parseDroppedExchangeConsolidationOutput(text).facts;
  }

  public async classifyMemoryConflict(existingStatement: string, newStatement: string): Promise<boolean> {
    const text = await this.callStructuredOutput(
      buildMemoryConflictClassificationPrompt(existingStatement, newStatement),
      "memory_conflict_classification",
      memoryConflictClassificationJsonSchema,
    );
    return parseMemoryConflictClassificationOutput(text).related;
  }

  public async summarizeReplyChainOverflow(
    hops: readonly { authorDisplayName: string; content: string }[],
  ): Promise<string> {
    const text = await this.callStructuredOutput(
      buildReplyChainOverflowSummaryPrompt(hops),
      "reply_chain_overflow_summary",
      replyChainOverflowSummaryJsonSchema,
    );
    return parseReplyChainOverflowSummaryOutput(text).summary;
  }

  public async compilePersonaBundle(content: string): Promise<readonly number[]> {
    const text = await this.callStructuredOutput(
      buildPersonaBundleCompilationPrompt(content),
      "persona_bundle_compilation",
      personaBundleCompilationJsonSchema,
      { maxOutputTokens: personaBundleCompilationMaxOutputTokens, timeoutMs: personaBundleCompilationTimeoutMs },
    );
    return [...parsePersonaBundleSectionSelection(text, content)];
  }

  public async evolvePersonaDrift(
    currentText: string,
    exchanges: readonly { user: string; assistant: string }[],
  ): Promise<string> {
    const text = await this.callStructuredOutput(
      buildPersonaDriftEvolutionPrompt(currentText, exchanges),
      "persona_drift_evolution",
      personaDriftEvolutionJsonSchema,
    );
    return parsePersonaDriftEvolutionOutput(text).text;
  }

  public async summarizeChannelMessages(
    guildId: string,
    messages: readonly ChannelSummaryMessage[],
  ): Promise<ChannelSummaryResult> {
    const summary = prepareChannelMessageSummary(guildId, messages);
    return this.summaryModelChain.run(async (model) => {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: summary.prompt,
          input: [{ role: "user", content: [{ type: "input_text", text: "Extract facts per the instructions." }] }],
          reasoning: { effort: this.generation.summaryReasoningEffort ?? this.generation.reasoningEffort },
          text: {
            verbosity: this.generation.verbosity,
            format: { type: "json_schema", name: "channel_message_summary", strict: true, schema: channelMessageSummaryJsonSchema },
          },
          max_output_tokens: this.generation.summaryMaxOutputTokens ?? channelMessageSummaryMaxOutputTokens,
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
      const parsed = responseSchema.parse(await response.json());
      if (parsed.status === "incomplete") {
        const reason = parsed.incomplete_details?.reason ?? "unknown";
        throw new ChatProviderError(
          `Chat provider returned an incomplete structured response (${reason}).`,
          502,
          "incomplete_response",
        );
      }
      const texts: string[] = [];
      for (const item of parsed.output) {
        if (item.type !== "message") continue;
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && part.text) texts.push(part.text);
        }
      }
      return summary.parse(texts.join("\n").trim());
    });
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
