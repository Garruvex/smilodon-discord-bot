import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatProviderError, type ChatProvider } from "../../src/application/chat/chat-provider.js";
import { OpenAiResponsesChatProvider } from "../../src/infrastructure/chat/openai-responses-chat-provider.js";
import { OpenAiCompatibleChatProvider } from "../../src/infrastructure/chat/openai-compatible-chat-provider.js";
import { GeminiChatProvider } from "../../src/infrastructure/chat/gemini-chat-provider.js";

const generateContent = vi.fn();
vi.mock("@google/genai", () => ({ GoogleGenAI: vi.fn().mockImplementation(function (this: { models: { generateContent: typeof generateContent } }) {
  this.models = { generateContent };
}) }));
afterEach(() => { vi.unstubAllGlobals(); generateContent.mockReset(); });

describe.each(["responses", "compatible", "gemini"] as const)("%s structured attempt authorization", (kind) => {
  it.each((["character", "conflict", "preferences", "compile", "consolidation", "drift", "overflow"] as const).filter((operation) => kind !== "compatible" || !["compile", "consolidation", "drift", "overflow"].includes(operation)))("checks the source guard before each %s fallback", async (operation) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "rate_limit" } }), { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    generateContent.mockRejectedValue(new ChatProviderError("limited", 429, "rate_limit"));
    const generation = { reasoningEffort: "low" as const, verbosity: "low" as const, maxOutputTokens: 100 };
    const provider: ChatProvider = kind === "responses" ? new OpenAiResponsesChatProvider("https://example.test", "secret", ["first", "second"], generation)
      : kind === "compatible" ? new OpenAiCompatibleChatProvider("https://example.test", "secret", ["first", "second"], null)
      : new GeminiChatProvider("secret", ["first", "second"], { maxOutputTokens: 100, thinkingBudget: null });
    let attempts = 0;
    const options = { beforeAttempt: (): Promise<void> => ++attempts === 1 ? Promise.resolve() : Promise.reject(new Error("source_revoked")) };
    const pending = operation === "character" ? provider.generateCharacterData!("AUTHORIZED_SENTINEL", {}, options)
      : operation === "conflict" ? provider.classifyMemoryConflict!("AUTHORIZED_OLD", "AUTHORIZED_NEW", options)
        : operation === "preferences" ? provider.analyzeUserCustomization!("AUTHORIZED_PREFERENCES", options)
          : operation === "compile" ? provider.compilePersonaBundle!("## Voice\nAUTHORIZED_CONFIGURATION", options)
            : operation === "consolidation" ? provider.summarizeDroppedExchanges!([{ user: "AUTHORIZED_USER", assistant: "AUTHORIZED_REPLY" }], { id: "user", displayName: "User" }, options)
              : operation === "drift" ? provider.evolvePersonaDrift!("AUTHORIZED_STATE", [{ user: "AUTHORIZED_USER", assistant: "AUTHORIZED_REPLY" }], options)
                : provider.summarizeReplyChainOverflow!([{ authorDisplayName: "User", content: "AUTHORIZED_ANCESTOR" }], options);
    await expect(pending).rejects.toThrow("source_revoked");
    expect(attempts).toBe(2);
    expect(kind === "gemini" ? generateContent : fetch).toHaveBeenCalledOnce();
  });
});
