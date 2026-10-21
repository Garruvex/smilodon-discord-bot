import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiResponsesChatProvider } from "../../src/infrastructure/chat/openai-responses-chat-provider.js";
import { OpenAiCompatibleChatProvider } from "../../src/infrastructure/chat/openai-compatible-chat-provider.js";
import { HttpDecisionProvider } from "../../src/infrastructure/chat/http-decision-provider.js";
import { CharacterDecisionService } from "../../src/application/chat/character-decision.js";
import { decisionProposal } from "../helpers/conversation-decision-fixtures.js";
import { reportStructuredUsage } from "../../src/application/chat/chat-provider.js";

afterEach(() => vi.unstubAllGlobals());
describe("content-free structured usage", () => {
  it.each(["responses", "compatible", "dedicated"] as const)("reports %s usage without changing parsed output or allowing observers to trigger retries", async (kind) => {
    const provider = kind === "responses" ? new OpenAiResponsesChatProvider("https://example.test/v1", "test", ["test-model"], { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2048 }) :
      kind === "compatible" ? new OpenAiCompatibleChatProvider("https://example.test/v1", "test", ["test-model"], null) : new HttpDecisionProvider({ baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model" });
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(kind === "responses" ? {
      output: [{ type: "message", content: [{ type: "output_text", text: '{"answer":true}' }] }],
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } },
    } : { choices: [{ message: { content: '{"answer":true}' } }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }))));
    vi.stubGlobal("fetch", fetch);
    const onUsage = vi.fn((): never => { throw new Error("Observer failed"); });
    expect(await provider.generateCharacterData("Synthetic prompt", { type: "object" }, { onUsage, maxAttempts: 1 })).toEqual({ answer: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 12, outputTokens: 5, totalTokens: 17,
      cachedInputTokens: kind === "responses" ? 4 : null, reasoningTokens: kind === "responses" ? 2 : null });
  });
  it("retains measured tokens when a proposal fails semantic validation", async () => {
    const service = new CharacterDecisionService({ generateCharacterData: (_prompt, _schema, options): Promise<unknown> => {
      reportStructuredUsage(options, { inputTokens: 12, outputTokens: 5, totalTokens: 17, cachedInputTokens: 0, reasoningTokens: 2 });
      return Promise.resolve(decisionProposal({ target: "unknown" }));
    } });
    const result = await service.evaluate({ personality: "test", events: [], burst: [], botId: "bot", fixedTarget: null, gapMs: 1000, speakingShare: 0, thoughts: false });
    expect(result.status).toBe("failed"); expect(result.attempts[0]).toMatchObject({ failure: "invalid_target", inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  });
  it("does not reject a dedicated provider result because optional usage is incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"ready":true}' } }], usage: { prompt_tokens: 4 } })))));
    const onUsage = vi.fn();
    const provider = new HttpDecisionProvider({ baseUrl: "https://example.test/v1", apiKey: "test", model: "test-model" });
    expect(await provider.generateCharacterData("Synthetic", {}, { onUsage })).toEqual({ ready: true });
    expect(onUsage).not.toHaveBeenCalled();
  });
});
