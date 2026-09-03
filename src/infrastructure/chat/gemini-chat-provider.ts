import { GoogleGenAI } from "@google/genai";
import type { Content, FunctionCall, GenerateContentResponse, Part, Tool } from "@google/genai";

import {
  ChatProviderError,
  chatSafetyGuard,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatResponseObserver,
  type ChatSource,
  type DroppedExchangeFact,
  type GeneratedChatImage,
  type UserCustomizationAnalysisResult,
} from "../../application/chat/chat-provider.js";
import type { ChatImage } from "../../application/chat/chat-provider.js";
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
  buildReplyChainOverflowSummaryPrompt,
  replyChainOverflowSummaryJsonSchema,
  parseReplyChainOverflowSummaryOutput,
} from "../../application/chat/reply-chain-overflow-summary.js";
import {
  buildUserCustomizationAnalysisPrompt,
  parseUserCustomizationAnalysisOutput,
  userCustomizationAnalysisJsonSchema,
} from "../../application/chat/user-customization-analysis.js";
import { generatedImageLimits } from "../../application/chat/generated-image-limits.js";

const maximumGeneratedImageBytes = generatedImageLimits.maxBytesPerImage;
const maximumGeneratedImagesPerReply = generatedImageLimits.maxImagesPerReply;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Same bound as OpenAiResponsesChatProvider — a model stuck calling tools in
// a loop can't run away on latency/cost.
const maxToolRoundTrips = 6;
// Same reasoning as OpenAiResponsesChatProvider: GenerateSelfImageTool's own
// image-generation request routinely takes longer than a text tool call.
const toolExecutionTimeoutMs = 60_000;
const toolBudgetExhaustedMessage = "Tool call budget exhausted. Do not call any more tools — answer now with what you already have, noting any gaps.";
// Gemini's image-capable models are addressed like any other model in the
// fallback list — this provider doesn't pick a separate model for image
// turns, unlike splitting a caption/chat pool. If a deployment's configured
// models don't support responseModalities:["TEXT","IMAGE"], image generation
// requests to that model simply return no inlineData parts.

export class GeminiChatProvider implements ChatProvider {
  private readonly modelChain: ModelFallbackChain;
  // Separate chain for the two standalone structured-output calls (own
  // prompt/schema, outside the main reply turn) — falls back to the primary
  // chain when the caller doesn't configure a cheaper summary model.
  private readonly summaryModelChain: ModelFallbackChain;
  private readonly client: GoogleGenAI;

  public constructor(
    apiKey: string,
    models: readonly string[],
    private readonly generation: {
      maxOutputTokens: number;
      thinkingBudget: number | null;
      summaryModels?: readonly string[];
      summaryMaxOutputTokens?: number;
    },
  ) {
    this.modelChain = new ModelFallbackChain(models);
    this.summaryModelChain = new ModelFallbackChain(generation.summaryModels ?? models);
    this.client = new GoogleGenAI({ apiKey });
  }

  public async reply(
    request: ChatRequest,
    observer?: ChatResponseObserver,
  ): Promise<ChatResponse> {
    void observer; // No partial-image-preview streaming for Gemini in v1 — see plan notes.
    const systemInstruction = buildChatInstructions(request, chatSafetyGuard);
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
      pendingGeneratedImages: [],
    };

    let contents: Content[] = [{
      role: "user",
      parts: [
        { text: buildChatContext(request) },
        ...request.images.flatMap((image) => this.imageToParts(image)),
      ],
    }];

    for (let roundTrip = 0; ; roundTrip++) {
      const response = await this.modelChain.run((model) =>
        this.generateContent(model, systemInstruction, contents, this.buildTools(request, customTools)));
      const functionCalls = response.functionCalls ?? [];

      if (functionCalls.length === 0) {
        return this.mergePendingImages(this.parseResponse(response, request), toolContext.pendingGeneratedImages);
      }

      if (roundTrip >= maxToolRoundTrips) {
        // Budget exhausted: force one last answer-only request with no tools
        // offered, mirroring OpenAiResponsesChatProvider's finalize step.
        contents = [
          ...contents,
          this.modelTurn(response),
          this.functionResponseTurn(functionCalls, functionCalls.map(() => ({ content: toolBudgetExhaustedMessage }))),
        ];
        const finalizeResponse = await this.modelChain.run((model) =>
          this.generateContent(model, systemInstruction, contents, undefined));
        return this.mergePendingImages(
          this.parseResponse(finalizeResponse, request),
          toolContext.pendingGeneratedImages,
        );
      }

      // Sequential, not Promise.all — see openai-responses-chat-provider.ts's
      // executeToolCall loop for why: several tools are stateful, and
      // running them concurrently would apply them out of the order the
      // model intended.
      const results: ChatToolResult[] = [];
      for (const call of functionCalls) {
        results.push(await this.executeToolCall(call, customTools, toolContext));
      }
      contents = [
        ...contents,
        this.modelTurn(response),
        this.functionResponseTurn(functionCalls, results),
      ];
    }
  }

  private imageToParts(image: ChatImage): Part[] {
    const match = /^data:([^;]+);base64,(.+)$/.exec(image.dataUrl);
    if (!match) return [];
    const mimeType = match[1] ?? "application/octet-stream";
    const data = match[2] ?? "";
    const label = image.source === "current_message"
      ? `CURRENT MESSAGE IMAGE ${image.sourceIndex + 1} (untrusted image input):`
      : `REPLY CHAIN IMAGE ${image.sourceIndex + 1} (untrusted image input):`;
    return [{ text: label }, { inlineData: { mimeType, data } }];
  }

  private buildTools(request: ChatRequest, customTools: readonly ChatTool[]): Tool[] | undefined {
    const tools: Tool[] = [];
    if (request.webSearchMode === "auto") tools.push({ googleSearch: {} });
    if (customTools.length > 0) {
      tools.push({
        functionDeclarations: customTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        })),
      });
    }
    if (request.imageGenerationEnabled) {
      // Gemini's image output is a response modality, not a tool — handled
      // via responseModalities in generateContent, not here.
    }
    return tools.length > 0 ? tools : undefined;
  }

  private async generateContent(
    model: string,
    systemInstruction: string,
    contents: Content[],
    tools: Tool[] | undefined,
  ): Promise<GenerateContentResponse> {
    try {
      return await this.client.models.generateContent({
        model,
        contents,
        config: {
          abortSignal: AbortSignal.timeout(60_000),
          systemInstruction,
          maxOutputTokens: this.generation.maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: chatModelJsonSchema,
          ...(tools ? { tools } : {}),
          ...(this.generation.thinkingBudget !== null
            ? { thinkingConfig: { thinkingBudget: this.generation.thinkingBudget } }
            : {}),
        },
      });
    } catch (error) {
      // A dropped/empty response from the SDK surfaces here as a thrown
      // error or as a response with no candidates — normalize both into the
      // same ChatProviderError shape the fallback chain and callers expect.
      if (error instanceof ChatProviderError) throw error;
      throw new ChatProviderError(
        error instanceof Error ? error.message : "Gemini request failed.",
        502,
        "gemini_request_failed",
      );
    }
  }

  private modelTurn(response: GenerateContentResponse): Content {
    const content = response.candidates?.[0]?.content;
    if (content) return content;
    // No content on the response (shouldn't happen alongside functionCalls,
    // but functionCalls is a derived getter) — reconstruct a minimal turn
    // from the calls themselves so the conversation stays well-formed.
    return {
      role: "model",
      parts: (response.functionCalls ?? []).map((call) => ({ functionCall: call })),
    };
  }

  private functionResponseTurn(calls: readonly FunctionCall[], results: readonly ChatToolResult[]): Content {
    return {
      role: "user",
      parts: calls.map((call, index) => ({
        functionResponse: { name: call.name ?? "", response: { output: results[index]?.content ?? "" } },
      })),
    };
  }

  private async executeToolCall(
    call: FunctionCall,
    tools: readonly ChatTool[],
    ctx: ChatToolContext,
  ): Promise<ChatToolResult> {
    const tool = tools.find((candidate) => candidate.name === call.name);
    if (!tool) return { content: `Unknown tool "${call.name}".` };
    // Racing a timer can't actually cancel tool.execute() — the loser keeps
    // running after this returns. The AbortController at least lets a
    // side-effecting tool (see ChatToolContext.signal) notice and bail out
    // right before it would otherwise mutate anything.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), toolExecutionTimeoutMs);
    try {
      return await Promise.race([
        tool.execute(call.args ?? {}, { ...ctx, signal: timeoutController.signal }),
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

  private parseResponse(response: GenerateContentResponse, request: ChatRequest): ChatResponse {
    const text = response.text ?? "";
    const modelOutput = parseChatModelOutput(text.trim());
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const sources = new Map<string, ChatSource>();
    if (request.includeSources) {
      for (const chunk of groundingChunks) {
        const url = chunk.web?.uri;
        if (!url) continue;
        sources.set(url, { title: chunk.web?.title?.trim() || new URL(url).hostname, url });
      }
    }
    const generatedImages = (response.candidates?.[0]?.content?.parts ?? [])
      .filter((part): part is Part & { inlineData: { data: string; mimeType?: string } } =>
        Boolean(part.inlineData?.data))
      .slice(0, maximumGeneratedImagesPerReply)
      .map((part, index) => this.decodeGeneratedImage(part.inlineData.data, `generated-image-${index + 1}.png`))
      .filter((image) => image !== null);
    const usage = response.usageMetadata;
    return {
      text: modelOutput.response,
      userMemoryActions: modelOutput.userMemoryActions,
      guildKnowledgeCandidates: modelOutput.guildKnowledgeCandidates,
      sources: [...sources.values()].slice(0, 5),
      usage: usage
        ? {
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: usage.candidatesTokenCount ?? 0,
            totalTokens: usage.totalTokenCount ?? 0,
            cachedInputTokens: usage.cachedContentTokenCount ?? null,
            reasoningTokens: usage.thoughtsTokenCount ?? null,
          }
        : null,
      webSearchUsed: groundingChunks.length > 0,
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

  private mergePendingImages(response: ChatResponse, pending: readonly GeneratedChatImage[]): ChatResponse {
    if (pending.length === 0) return response;
    return { ...response, generatedImages: [...response.generatedImages, ...pending] };
  }

  // Isolated, one-shot request for GenerateSelfImageTool — deliberately not
  // built via the main reply()/generateContent path, which is coupled to the
  // full conversational turn (persona instructions, structured-output
  // schema, tool loop). Sets responseModalities explicitly since this call
  // exists for no other reason than to get an image back (unlike the main
  // flow's generateContent, which doesn't set it at all today — seemingly a
  // pre-existing gap there, left alone since fixing the main flow's image
  // generation is out of scope here).
  public async generateReferenceImage(
    prompt: string,
    reference: { data: Buffer; contentType: string },
  ): Promise<{ ok: true; images: readonly GeneratedChatImage[] } | { ok: false; reason: string }> {
    try {
      const response = await this.modelChain.run((model) => this.client.models.generateContent({
        model,
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: reference.contentType, data: reference.data.toString("base64") } },
          ],
        }],
        config: {
          abortSignal: AbortSignal.timeout(50_000),
          responseModalities: ["TEXT", "IMAGE"],
        },
      }));
      const images = (response.candidates?.[0]?.content?.parts ?? [])
        .filter((part): part is Part & { inlineData: { data: string; mimeType?: string } } =>
          Boolean(part.inlineData?.data))
        .slice(0, maximumGeneratedImagesPerReply)
        .map((part, index) => this.decodeGeneratedImage(part.inlineData.data, `self-image-${index + 1}.png`))
        .filter((image): image is NonNullable<typeof image> => image !== null);
      if (images.length === 0) return { ok: false, reason: "no image came back from the model." };
      return { ok: true, images };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "the request failed." };
    }
  }

  public async analyzeUserCustomization(rawText: string): Promise<UserCustomizationAnalysisResult> {
    const response = await this.summaryModelChain.run((model) => this.generateStructured(
      model,
      buildUserCustomizationAnalysisPrompt(rawText),
      userCustomizationAnalysisJsonSchema,
    ));
    const analysis = parseUserCustomizationAnalysisOutput((response.text ?? "").trim());
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
    const response = await this.summaryModelChain.run((model) => this.generateStructured(
      model,
      buildDroppedExchangeConsolidationPrompt(exchanges, speaker),
      droppedExchangeConsolidationJsonSchema,
    ));
    return parseDroppedExchangeConsolidationOutput((response.text ?? "").trim()).facts;
  }

  public async classifyMemoryConflict(existingStatement: string, newStatement: string): Promise<boolean> {
    const response = await this.summaryModelChain.run((model) => this.generateStructured(
      model,
      buildMemoryConflictClassificationPrompt(existingStatement, newStatement),
      memoryConflictClassificationJsonSchema,
    ));
    return parseMemoryConflictClassificationOutput((response.text ?? "").trim()).related;
  }

  public async summarizeReplyChainOverflow(
    hops: readonly { authorDisplayName: string; content: string }[],
  ): Promise<string> {
    const response = await this.summaryModelChain.run((model) => this.generateStructured(
      model,
      buildReplyChainOverflowSummaryPrompt(hops),
      replyChainOverflowSummaryJsonSchema,
    ));
    return parseReplyChainOverflowSummaryOutput((response.text ?? "").trim()).summary;
  }

  public async compilePersonaBundle(content: string): Promise<readonly number[]> {
    const response = await this.summaryModelChain.run((model) => this.generateStructured(
      model,
      buildPersonaBundleCompilationPrompt(content),
      personaBundleCompilationJsonSchema,
      personaBundleCompilationMaxOutputTokens,
      personaBundleCompilationTimeoutMs,
    ));
    return [...parsePersonaBundleSectionSelection((response.text ?? "").trim(), content)];
  }

  public async evolvePersonaDrift(
    currentText: string,
    exchanges: readonly { user: string; assistant: string }[],
  ): Promise<string> {
    const response = await this.summaryModelChain.run((model) => this.generateStructured(
      model,
      buildPersonaDriftEvolutionPrompt(currentText, exchanges),
      personaDriftEvolutionJsonSchema,
    ));
    return parsePersonaDriftEvolutionOutput((response.text ?? "").trim()).text;
  }

  public async summarizeChannelMessages(
    guildId: string,
    messages: readonly ChannelSummaryMessage[],
  ): Promise<ChannelSummaryResult> {
    const summary = prepareChannelMessageSummary(guildId, messages);
    const response = await this.summaryModelChain.run((model) => this.generateStructured(
      model,
      summary.prompt,
      channelMessageSummaryJsonSchema,
      this.generation.summaryMaxOutputTokens ?? channelMessageSummaryMaxOutputTokens,
    ));
    return summary.parse((response.text ?? "").trim());
  }

  // Shared by the two standalone structured-output calls (own prompt/schema,
  // outside the main reply turn) — the main reply() path stays separate
  // since it also needs tool round-trips and image parts.
  private async generateStructured(
    model: string,
    prompt: string,
    jsonSchema: Record<string, unknown>,
    maxOutputTokens: number = this.generation.maxOutputTokens,
    timeoutMs = 30_000,
  ): Promise<GenerateContentResponse> {
    try {
      return await this.client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: "Follow the instructions above." }] }],
        config: {
          abortSignal: AbortSignal.timeout(timeoutMs),
          systemInstruction: prompt,
          maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
        },
      });
    } catch (error) {
      if (error instanceof ChatProviderError) throw error;
      throw new ChatProviderError(
        error instanceof Error ? error.message : "Gemini request failed.",
        502,
        "gemini_request_failed",
      );
    }
  }
}
