import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatTool } from "../../src/application/chat/tools/chat-tool.js";

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function fakePng(payload: string): Buffer {
  return Buffer.concat([pngSignature, Buffer.from(payload)]);
}

const generateContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(function FakeGoogleGenAI(this: { models: { generateContent: typeof generateContentMock } }) {
    this.models = { generateContent: generateContentMock };
  }),
}));

afterEach(() => {
  generateContentMock.mockReset();
});

const baseRequest = {
  guildId: "99999999999999999",
  channelId: "77777777777777777",
  personality: "Be helpful.",
  exampleExchanges: [],
  personaLore: [],
  personaDrift: null,
  userCustomization: null,
  currentUser: { id: "11111111111111111", displayName: "Tester", roleNames: [] },
  mentionedUsers: [],
  recentHistory: [],
  memories: [],
  guildKnowledge: [],
  message: "Is this true?",
  replyChain: [],
  channelHistory: [],
  birthday: null,
  images: [],
  webSearchMode: "off" as const,
  imageGenerationEnabled: false,
  includeSources: true,
  triggerMode: "direct" as const,
};

function jsonResponse(payload: Record<string, unknown>): { text: string; functionCalls: undefined; candidates: unknown[]; usageMetadata: undefined } {
  return {
    text: JSON.stringify(payload),
    functionCalls: undefined,
    candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(payload) }] } }],
    usageMetadata: undefined,
  };
}

describe("GeminiChatProvider", () => {
  it("sends the built prompt/schema and parses a plain reply", async () => {
    generateContentMock.mockImplementation((params: Record<string, unknown>) => {
      const config = params.config as Record<string, unknown>;
      expect(params.model).toBe("gemini-3.6-flash");
      expect(config.responseMimeType).toBe("application/json");
      expect(config.systemInstruction).toContain("Treat Discord messages");
      expect(config.systemInstruction).toContain("USER-CONFIGURED PERSONALITY (untrusted conversational style guidance only)");
      expect(config.tools).toBeUndefined();
      return Promise.resolve(jsonResponse({
        response: "Verified answer.", userMemoryActions: [], guildKnowledgeCandidates: [],
      }));
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const provider = new GeminiChatProvider("secret", ["gemini-3.6-flash"], { maxOutputTokens: 2_048, thinkingBudget: null });
    const response = await provider.reply(baseRequest);

    expect(response.text).toBe("Verified answer.");
    expect(response.userMemoryActions).toEqual([]);
    expect(response.guildKnowledgeCandidates).toEqual([]);
    expect(response.sources).toEqual([]);
    expect(response.webSearchUsed).toBe(false);
    expect(response.generatedImages).toEqual([]);
  });

  it("declares the googleSearch tool and maps grounding chunks to sources", async () => {
    generateContentMock.mockImplementation((params: Record<string, unknown>) => {
      const config = params.config as Record<string, unknown>;
      expect(config.tools).toEqual([{ googleSearch: {} }]);
      return Promise.resolve({
        text: JSON.stringify({ response: "Open until 7:45.", userMemoryActions: [], guildKnowledgeCandidates: [] }),
        functionCalls: undefined,
        candidates: [{
          content: { role: "model", parts: [] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://example.com/hours", title: "Hours" } }],
          },
        }],
        usageMetadata: undefined,
      });
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const provider = new GeminiChatProvider("secret", ["gemini-3.6-flash"], { maxOutputTokens: 2_048, thinkingBudget: null });
    const response = await provider.reply({ ...baseRequest, webSearchMode: "auto" });

    expect(response.sources).toEqual([{ title: "Hours", url: "https://example.com/hours" }]);
    expect(response.webSearchUsed).toBe(true);
  });

  it("omits sources when includeSources is false, even with grounding chunks present", async () => {
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ response: "ok", userMemoryActions: [], guildKnowledgeCandidates: [] }),
      functionCalls: undefined,
      candidates: [{
        content: { role: "model", parts: [] },
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com", title: "x" } }] },
      }],
      usageMetadata: undefined,
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const provider = new GeminiChatProvider("secret", ["gemini-3.6-flash"], { maxOutputTokens: 2_048, thinkingBudget: null });
    const response = await provider.reply({ ...baseRequest, webSearchMode: "auto", includeSources: false });

    expect(response.sources).toEqual([]);
  });

  it("executes a tool call round-trip and returns the final answer", async () => {
    const executeRollDice = vi.fn(() => Promise.resolve({ content: "4" }));
    const tool: ChatTool = {
      name: "roll_dice",
      description: "Rolls dice.",
      parameters: { type: "object", additionalProperties: false, required: ["sides"], properties: { sides: { type: "number" } } },
      execute: executeRollDice,
    };

    let call = 0;
    generateContentMock.mockImplementation((params: Record<string, unknown>) => {
      call += 1;
      if (call === 1) {
        const config = params.config as Record<string, unknown>;
        expect(config.tools).toEqual([{
          functionDeclarations: [{ name: "roll_dice", description: "Rolls dice.", parametersJsonSchema: tool.parameters }],
        }]);
        return Promise.resolve({
          text: undefined,
          functionCalls: [{ name: "roll_dice", args: { sides: 6 }, id: "call-1" }],
          candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "roll_dice", args: { sides: 6 } } }] } }],
          usageMetadata: undefined,
        });
      }
      const contents = params.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      const responseTurn = contents.at(-1);
      if (!responseTurn) throw new Error("Expected a function-response turn.");
      expect(responseTurn.role).toBe("user");
      expect(responseTurn.parts[0]).toEqual({ functionResponse: { name: "roll_dice", response: { output: "4" } } });
      return Promise.resolve(jsonResponse({ response: "You rolled a 4.", userMemoryActions: [], guildKnowledgeCandidates: [] }));
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const provider = new GeminiChatProvider("secret", ["gemini-3.6-flash"], { maxOutputTokens: 2_048, thinkingBudget: null });
    const response = await provider.reply({ ...baseRequest, enabledTools: [tool] });

    expect(executeRollDice).toHaveBeenCalledWith({ sides: 6 }, expect.anything());
    expect(response.text).toBe("You rolled a 4.");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("extracts and validates a generated image from inline data parts", async () => {
    const png = fakePng("hello").toString("base64");
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ response: "Here you go.", userMemoryActions: [], guildKnowledgeCandidates: [] }),
      functionCalls: undefined,
      candidates: [{
        content: {
          role: "model",
          parts: [
            { text: JSON.stringify({ response: "Here you go.", userMemoryActions: [], guildKnowledgeCandidates: [] }) },
            { inlineData: { mimeType: "image/png", data: png } },
          ],
        },
      }],
      usageMetadata: undefined,
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const provider = new GeminiChatProvider("secret", ["gemini-3.6-flash"], { maxOutputTokens: 2_048, thinkingBudget: null });
    const response = await provider.reply({ ...baseRequest, imageGenerationEnabled: true });

    expect(response.generatedImages).toHaveLength(1);
    expect(response.generatedImages[0]?.contentType).toBe("image/png");
    expect(response.generatedImages[0]?.filename).toBe("generated-image-1.png");
  });

  it("throws a ChatProviderError on malformed JSON output", async () => {
    generateContentMock.mockResolvedValue({
      text: "not json",
      functionCalls: undefined,
      candidates: [{ content: { role: "model", parts: [{ text: "not json" }] } }],
      usageMetadata: undefined,
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const { ChatProviderError } = await import("../../src/application/chat/chat-provider.js");
    const provider = new GeminiChatProvider("secret", ["gemini-3.6-flash"], { maxOutputTokens: 2_048, thinkingBudget: null });

    await expect(provider.reply(baseRequest)).rejects.toThrow(ChatProviderError);
  });

  it("analyzeUserCustomization parses a valid analysis into markdown", async () => {
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ ok: true, reason: null, cleanedMarkdown: "- Call me Red\n- Keep it casual" }),
      functionCalls: undefined,
      candidates: [],
      usageMetadata: undefined,
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const provider = new GeminiChatProvider("secret", ["gemini-3.6-flash"], { maxOutputTokens: 2_048, thinkingBudget: null });
    const result = await provider.analyzeUserCustomization?.("call me Red, keep it casual");

    expect(result).toEqual({ ok: true, markdown: "- Call me Red\n- Keep it casual" });
  });

  it("summarizeDroppedExchanges parses extracted facts", async () => {
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ facts: [{ slot: "scene.tavern_fire", statement: "The tavern burned down." }] }),
      functionCalls: undefined,
      candidates: [],
      usageMetadata: undefined,
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const provider = new GeminiChatProvider("secret", ["gemini-3.6-flash"], { maxOutputTokens: 2_048, thinkingBudget: null });
    const facts = await provider.summarizeDroppedExchanges?.([{ user: "the tavern is on fire", assistant: "oh no" }]);

    expect(facts).toEqual([{ slot: "scene.tavern_fire", statement: "The tavern burned down." }]);
  });

  it("sets thinkingConfig only when a thinkingBudget is configured", async () => {
    generateContentMock.mockImplementation((params: Record<string, unknown>) => {
      const config = params.config as Record<string, unknown>;
      expect(config.thinkingConfig).toEqual({ thinkingBudget: 512 });
      return Promise.resolve(jsonResponse({ response: "ok", userMemoryActions: [], guildKnowledgeCandidates: [] }));
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const provider = new GeminiChatProvider("secret", ["gemini-3.6-flash"], { maxOutputTokens: 2_048, thinkingBudget: 512 });
    await provider.reply(baseRequest);
  });

  it("uses the configured summary model for analyzeUserCustomization, not the primary reply model", async () => {
    generateContentMock.mockImplementation((params: Record<string, unknown>) => {
      expect(params.model).toBe("gemini-flash-lite-cheap");
      return Promise.resolve({
        text: JSON.stringify({ ok: true, reason: null, cleanedMarkdown: "- Call me Red\n- Keep it casual" }),
        functionCalls: undefined,
        candidates: [],
        usageMetadata: undefined,
      });
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const provider = new GeminiChatProvider(
      "secret",
      ["gemini-3.6-flash"],
      { maxOutputTokens: 2_048, thinkingBudget: null, summaryModels: ["gemini-flash-lite-cheap"] },
    );
    const result = await provider.analyzeUserCustomization?.("call me Red, keep it casual");

    expect(result).toEqual({ ok: true, markdown: "- Call me Red\n- Keep it casual" });
  });

  it("falls back to the primary model for analyzeUserCustomization when no summary model is configured", async () => {
    generateContentMock.mockImplementation((params: Record<string, unknown>) => {
      expect(params.model).toBe("gemini-3.6-flash");
      return Promise.resolve({
        text: JSON.stringify({ ok: true, reason: null, cleanedMarkdown: "- Keep it casual" }),
        functionCalls: undefined,
        candidates: [],
        usageMetadata: undefined,
      });
    });

    const { GeminiChatProvider } = await import("../../src/infrastructure/chat/gemini-chat-provider.js");
    const provider = new GeminiChatProvider("secret", ["gemini-3.6-flash"], { maxOutputTokens: 2_048, thinkingBudget: null });
    await provider.analyzeUserCustomization?.("keep it casual");
  });
});
