import { GoogleGenAI } from "@google/genai";

import type {
  StructuredModelClient,
  StructuredModelRequest,
  StructuredModelResponse,
} from "../../../application/campaign/ports/structured-model-client.js";
import { ChatProviderError } from "../../../application/chat/chat-provider.js";
import { ModelFallbackChain } from "../../chat/model-fallback-chain.js";

export interface GeminiClientOptions {
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly thinkingBudget?: number;
}

export class GeminiStructuredClient implements StructuredModelClient {
  public readonly name = "gemini";
  private readonly chain: ModelFallbackChain;
  private readonly client: GoogleGenAI;

  public constructor(private readonly options: GeminiClientOptions) {
    this.chain = new ModelFallbackChain(options.models);
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
  }

  public generate(request: StructuredModelRequest): Promise<StructuredModelResponse> {
    return this.chain.run(async (model) => {
      try {
        const response = await this.client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: request.user }] }],
          config: {
            abortSignal: AbortSignal.timeout(request.timeoutMs),
            systemInstruction: request.system,
            maxOutputTokens: request.maxOutputTokens,
            responseMimeType: "application/json",
            responseJsonSchema: request.jsonSchema,
            ...(this.options.thinkingBudget === undefined ? {} : { thinkingConfig: { thinkingBudget: this.options.thinkingBudget } }),
          },
        });
        const usage = response.usageMetadata;
        return {
          text: (response.text ?? "").trim(),
          model,
          usage:
            usage === undefined
              ? null
              : {
                  inputTokens: usage.promptTokenCount ?? 0,
                  outputTokens: usage.candidatesTokenCount ?? 0,
                  cachedInputTokens: usage.cachedContentTokenCount ?? 0,
                },
        };
      } catch (error) {
        if (error instanceof ChatProviderError) throw error;
        // The SDK's ApiError carries the HTTP status; keep 429 so the chain
        // can move to the next model.
        const status = (error as { status?: unknown }).status;
        throw new ChatProviderError(
          error instanceof Error ? error.message : "Gemini request failed.",
          typeof status === "number" ? status : 502,
          "gemini_request_failed",
        );
      }
    });
  }
}
