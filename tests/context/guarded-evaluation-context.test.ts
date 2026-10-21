import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedEvaluationContext } from "../../src/application/context/guarded-evaluation-context.js";
import { ConfigurationModelGateway } from "../../src/application/context/configuration-model-gateway.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { characterSettingsSchema } from "../../src/application/chat/character-settings.js";
import { OpenAiResponsesChatProvider } from "../../src/infrastructure/chat/openai-responses-chat-provider.js";
import { buildChatContext, buildChatInstructions } from "../../src/infrastructure/chat/chat-structured-output.js";
import { configurationFixture } from "../helpers/configuration-context-fixture.js";
import { decisionResponse } from "../helpers/conversation-decision-fixtures.js";
import type { ChatRequest } from "../../src/application/chat/chat-provider.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
async function fixture(): Promise<{ context: GuardedEvaluationContext; revoke: () => void; changePersona: () => void }> {
  let allowed = true; let personaCurrent = true;
  const persona = await configurationFixture("AUTHORIZED_PERSONA", "persona", () => personaCurrent, "guild");
  const context = await GuardedEvaluationContext.open({ guildId: "guild", channelId: "channel", reviewerId: "reviewer" }, persona,
    "AUTHORIZED_QUESTION", characterSettingsSchema.parse({}), () => allowed);
  return { context, revoke: (): void => { allowed = false; }, changePersona: (): void => { personaCurrent = false; } };
}

describe("configuration-only character evaluation", () => {
  it.each(["raw", "copy"] as const)("rejects %s evaluation authority before dispatch", async (kind) => {
    const { context } = await fixture(); const reply = vi.fn(() => Promise.resolve(decisionResponse()));
    const input = kind === "copy" ? { ...context } : { scope: context.scope, persona: context.persona, question: "unregistered" };
    await expect(new ConfigurationModelGateway({ reply }).probe(input as GuardedEvaluationContext)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(reply).not.toHaveBeenCalled();
  });
  it("owns the final payload and gives probes no participant or learned-state fields", async () => {
    const { context } = await fixture(); const captured: string[] = [];
    const reply = vi.fn((request: ChatRequest) => {
      expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.currentUser)).toBe(true);
      expect(request).toMatchObject({ currentUser: { id: "synthetic-reviewer" }, memories: [], guildKnowledge: [], recentHistory: [],
        channelHistory: [], personaDrift: null, birthday: null, userCustomization: null, enabledTools: [], webSearchMode: "off", imageGenerationEnabled: false });
      captured.push(buildChatInstructions(request, "safety") + buildChatContext(request)); return Promise.resolve(decisionResponse());
    });
    expect(() => { (context as unknown as { memories: string }).memories = "PRIVATE_MEMBER_MEMORY"; }).toThrow();
    expect(() => { (context.scope as { reviewerId: string }).reviewerId = "other"; }).toThrow();
    await new ConfigurationModelGateway({ reply }).probe(context);
    expect(captured[0]).toContain("AUTHORIZED_PERSONA"); expect(captured[0]).toContain("AUTHORIZED_QUESTION");
    expect(captured[0]).not.toContain("PRIVATE_MEMBER_MEMORY");
  });
  it.each(["reviewer", "persona"] as const)("rejects %s revocation before consuming a model call", async (kind) => {
    const { context, revoke, changePersona } = await fixture(); const reply = vi.fn(() => Promise.resolve(decisionResponse()));
    if (kind === "reviewer") revoke(); else changePersona();
    await expect(new ConfigurationModelGateway({ reply }).probe(context)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(reply).not.toHaveBeenCalled();
  });
  it("stops an actual transport fallback when reviewer authority is revoked", async () => {
    const { context, revoke } = await fixture();
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      expect(init?.body).toEqual(expect.stringContaining("AUTHORIZED_QUESTION")); revoke();
      return Promise.resolve(new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 }));
    });
    vi.stubGlobal("fetch", fetch);
    const provider = new OpenAiResponsesChatProvider("https://api.openai.com/v1", "synthetic-key", ["primary", "fallback"], { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2048 });
    await expect(new ConfigurationModelGateway(provider).probe(context)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects changed authority after generation instead of exposing the result", async () => {
    const { context, revoke } = await fixture(); const reply = vi.fn(() => { revoke(); return Promise.resolve(decisionResponse()); });
    await expect(new ConfigurationModelGateway({ reply }).probe(context)).rejects.toBeInstanceOf(SocialOutputSuppressed);
  });
  it("keeps runtime cancellation attached to provider attempts", async () => {
    const { context } = await fixture(); let active = true; const external = vi.fn();
    const reply = vi.fn(async (request: ChatRequest) => {
      await request.beforeModelAttempt!(); external(); active = false;
      await request.beforeModelAttempt!(); external(); return decisionResponse();
    });
    await expect(new ConfigurationModelGateway({ reply }).probe(context, true, () => active)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(external).toHaveBeenCalledOnce();
  });
  it("rejects a mismatched persona audience and oversized synthetic input", async () => {
    const { context } = await fixture();
    for (const [guildId, question] of [["other", "question"], ["guild", "x".repeat(501)]])
      await expect(GuardedEvaluationContext.open({ ...context.scope, guildId: guildId! }, context.persona, question!, context.settings, () => true)).rejects.toBeInstanceOf(SocialOutputSuppressed);
  });
});
