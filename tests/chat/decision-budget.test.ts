import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterDecisionService } from "../../src/application/chat/character-decision.js";
import type { StructuredCallOptions } from "../../src/application/chat/chat-provider.js";
import { branchCurrent, decisionProposal } from "../helpers/conversation-decision-fixtures.js";
import { OpenAiResponsesChatProvider } from "../../src/infrastructure/chat/openai-responses-chat-provider.js";
import { OpenAiCompatibleChatProvider } from "../../src/infrastructure/chat/openai-compatible-chat-provider.js";
const input = { personality: "synthetic", events: [], burst: [branchCurrent], botId: "bot", fixedTarget: "current", gapMs: 1000, speakingShare: 0, thoughts: false };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("bounded decision recovery", () => {
  it("reserves generation time instead of starting a doomed decision attempt", async () => {
    const generateCharacterData = vi.fn(() => Promise.resolve(decisionProposal()));
    const result = await new CharacterDecisionService({ generateCharacterData }).evaluate({ ...input, contextual: true, deadlineAt: Date.now() + 10500 });
    expect(result).toMatchObject({ status: "failed", attempts: [{ stage: "context_validation", failure: "timeout" }] });
    expect(generateCharacterData).not.toHaveBeenCalled();
  });
  it("reserves model time independently of slow source validation", async () => {
    vi.useFakeTimers();
    const primary = { generateCharacterData: (): Promise<unknown> => new Promise(() => undefined) };
    const fallback = { generateCharacterData: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(decisionProposal()), 5000))) };
    const guard = vi.fn(() => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2000)));
    const outcome = new CharacterDecisionService(primary, fallback).evaluate({ ...input, canUseContext: guard });
    await vi.advanceTimersByTimeAsync(15000);
    const result = await outcome;
    expect(result.status).toBe("valid");
    expect(guard).toHaveBeenCalledTimes(2);
    expect(result.attempts).toEqual([expect.objectContaining({ failure: "timeout", timeoutMs: 6000 }), expect.objectContaining({ status: "valid", timeoutMs: 6000 })]);
  });
  it("bounds a stalled guard without calling or penalizing a provider", async () => {
    vi.useFakeTimers();
    const generateCharacterData = vi.fn();
    const service = new CharacterDecisionService({ generateCharacterData });
    const outcome = service.evaluate({ ...input, canUseContext: () => new Promise(() => undefined) });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await outcome).toMatchObject({ status: "failed", attempts: [{ stage: "context_validation", failure: "timeout" }] });
    expect(generateCharacterData).not.toHaveBeenCalled();
    expect(service.healthStatus().lastFailureAt).toBeNull();
  });
  it("stops a decision fallback when its source guard is no longer current", async () => {
    let allowed = true;
    const primary = { generateCharacterData: vi.fn(() => { allowed = false; return Promise.reject(new Error("first endpoint failed")); }) };
    const fallback = { generateCharacterData: vi.fn(() => Promise.resolve(decisionProposal())) };
    const service = new CharacterDecisionService(primary, fallback);
    expect((await service.evaluate({ ...input, canUseContext: () => Promise.resolve(allowed) })).status).toBe("failed");
    expect(primary.generateCharacterData).toHaveBeenCalledOnce(); expect(fallback.generateCharacterData).not.toHaveBeenCalled();
  });
  it.each(["responses", "compatible"])("blocks every %s reply transport while a guard rejects it", async (kind) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const provider = kind === "responses" ? new OpenAiResponsesChatProvider("https://example.test", "secret", ["first", "second"], { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 100 })
      : new OpenAiCompatibleChatProvider("https://example.test", "secret", ["first", "second"], null);
    const { decisionRequest } = await import("../helpers/conversation-decision-fixtures.js");
    const beforeModelAttempt = vi.fn(() => Promise.reject(new Error("source invalidated")));
    await expect(provider.reply(decisionRequest({ beforeModelAttempt }))).rejects.toBeDefined();
    expect(beforeModelAttempt).toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("guards standalone attribution retries before sending source text", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { code: "rate_limit" } }), { status: 429 })));
    vi.stubGlobal("fetch", fetch);
    const provider = new OpenAiResponsesChatProvider("https://example.test", "secret", ["first", "second"], { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 100 });
    const beforeAttempt = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("source invalidated"));
    await expect(provider.verifyAttribution("synthetic", [], "current", beforeAttempt)).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledOnce(); expect(beforeAttempt.mock.calls.length).toBeGreaterThan(1);
  });
  it.each(["responses", "compatible"])("passes cancellation and a one-model budget into %s transport", async (kind) => {
    const fetch = vi.fn((_url: unknown, request?: RequestInit) => {
      expect(request?.signal).toBe(controller.signal);
      return Promise.resolve(new Response(JSON.stringify({ error: { code: "rate_limit" } }), { status: 429 }));
    });
    const controller = new AbortController(); vi.stubGlobal("fetch", fetch);
    const provider = kind === "responses" ? new OpenAiResponsesChatProvider("https://example.test", "secret", ["first", "second"], { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 100 })
      : new OpenAiCompatibleChatProvider("https://example.test", "secret", ["first", "second"], null);
    await expect(provider.generateCharacterData("synthetic", {}, { signal: controller.signal, maxAttempts: 1 })).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("aborts two stalled endpoint attempts inside the overall budget", async () => {
    vi.useFakeTimers(); const signals: AbortSignal[] = [];
    const pending = { generateCharacterData: (_prompt: string, _schema: object, options?: StructuredCallOptions): Promise<unknown> => { signals.push(options!.signal!); expect(options!.maxAttempts).toBe(1); return new Promise(() => undefined); } };
    const service = new CharacterDecisionService(pending, { ...pending });
    const outcome = service.evaluate(input); await vi.advanceTimersByTimeAsync(12_000);
    const result = await outcome;
    expect(result.status).toBe("failed"); expect(result.attempts.map((attempt) => attempt.failure)).toEqual(["timeout", "timeout"]);
    expect(signals).toHaveLength(2); expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it("uses cached circuit health and resumes after cooldown", async () => {
    vi.useFakeTimers(); const generate = vi.fn((): Promise<unknown> => Promise.reject(new Error("unavailable")));
    const service = new CharacterDecisionService({ generateCharacterData: generate });
    for (let i = 0; i < 3; i++) await service.evaluate(input);
    expect((await service.evaluate(input)).attempts[0]?.failure).toBe("provider_cooldown"); expect(generate).toHaveBeenCalledTimes(3);
    expect(service.healthStatus().coolingDownProviders).toBe(1);
    await vi.advanceTimersByTimeAsync(30_001); generate.mockImplementation(() => Promise.resolve(decisionProposal()));
    expect((await service.evaluate(input)).status).toBe("valid"); expect(service.healthStatus().coolingDownProviders).toBe(0);
  });
  it("caches a synthetic schema health check without using conversation content", async () => {
    const proposal = decisionProposal({ target: "diagnostic-source", recipientEvidence: ["diagnostic-source"], contribution: { ...decisionProposal().contribution, sourceMessageId: "diagnostic-source", recipientId: "diagnostic-human" } });
    const generate = vi.fn(() => Promise.resolve(proposal)); const service = new CharacterDecisionService({ generateCharacterData: generate });
    const first = service.checkHealth(); expect(service.checkHealth()).toBe(first);
    expect((await first).lastSuccessAt).not.toBeNull(); expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]).toBeDefined();
  });
});
