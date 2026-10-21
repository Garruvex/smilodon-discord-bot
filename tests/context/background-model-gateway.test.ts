import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedBackgroundContext } from "../../src/application/context/guarded-background-context.js";
import { BackgroundModelGateway } from "../../src/application/context/background-model-gateway.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { OpenAiResponsesChatProvider } from "../../src/infrastructure/chat/openai-responses-chat-provider.js";
import type { StructuredCallOptions } from "../../src/application/chat/chat-provider.js";
import type { ChannelSummaryResult } from "../../src/application/context/channel-message-summarizer.js";
import type { ChannelHistoryReader } from "../../src/application/context/channel-history-reader.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const source = { id: "message", guildId: "guild", channelId: "channel", authorId: "alice", authorDisplayName: "Alice", content: "AUTHORIZED_INPUT", createdAt: 1 };
function fixture(): {
  reader: { readBatch: ReturnType<typeof vi.fn<ChannelHistoryReader["readBatch"]>>; validateBatch: ReturnType<typeof vi.fn<() => Promise<boolean>>> };
  provider: { summarizeChannelMessages: ReturnType<typeof vi.fn<(_guild: string, _messages: unknown, options?: StructuredCallOptions) => Promise<ChannelSummaryResult>>>;
    extractPersonalMemories: ReturnType<typeof vi.fn<() => Promise<never[]>>> };
  gateway: BackgroundModelGateway; deny: () => void;
} {
  let allowed = true;
  const reader = { readBatch: vi.fn<ChannelHistoryReader["readBatch"]>(), validateBatch: vi.fn(() => Promise.resolve(allowed)) };
  const provider = { summarizeChannelMessages: vi.fn((_guild: string, _messages: unknown, options?: StructuredCallOptions) => {
    return (async (): Promise<ChannelSummaryResult> => { await options?.beforeAttempt?.(); return { facts: [], relations: [] }; })();
  }), extractPersonalMemories: vi.fn(() => Promise.resolve([])) };
  const gateway = new BackgroundModelGateway(provider);
  return { reader, provider, gateway, deny: (): void => { allowed = false; } };
}

describe("registered background model boundary", () => {
  it("rejects forged, wrong-purpose and cross-subject contexts before the provider", async () => {
    const { gateway, provider, reader } = fixture();
    await expect(gateway.summarize({ ...source, purpose: "summary" } as never)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    const summary = await GuardedBackgroundContext.open("summary", [source], reader, () => true);
    await expect(gateway.extract(summary, "alice")).rejects.toBeInstanceOf(SocialOutputSuppressed);
    const extraction = await GuardedBackgroundContext.open("memory_extraction", [source], reader, () => true);
    await expect(gateway.extract(extraction, "bob")).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(provider.summarizeChannelMessages).not.toHaveBeenCalled(); expect(provider.extractPersonalMemories).not.toHaveBeenCalled();
  });

  it("takes an immutable snapshot and does not permit purpose widening", async () => {
    const { reader, gateway, provider } = fixture(); const input = { ...source };
    const context = await GuardedBackgroundContext.open("summary", [input], reader, () => true);
    input.content = "UNAPPROVED_MUTATION";
    expect(() => Reflect.defineProperty(context, "purpose", { value: "memory_extraction" })).not.toThrow();
    expect(context.purpose).toBe("summary");
    await gateway.summarize(context);
    expect(JSON.stringify(provider.summarizeChannelMessages.mock.calls)).not.toContain("UNAPPROVED_MUTATION");
    expect(provider.summarizeChannelMessages.mock.calls[0]?.[1]).toEqual([{ id: "message", authorId: "alice", authorDisplayName: "Alice", content: "AUTHORIZED_INPUT" }]);
  });

  it("rejects unsupported readers and lost eligibility before model input", async () => {
    await expect(GuardedBackgroundContext.open("summary", [source], { readBatch: vi.fn() }, () => true)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    const { reader, gateway, provider, deny } = fixture();
    const context = await GuardedBackgroundContext.open("summary", [source], reader, () => true); deny();
    await expect(gateway.summarize(context)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(provider.summarizeChannelMessages).not.toHaveBeenCalled();
  });

  it("revalidates inside an actual transport fallback and never sends a revoked source twice", async () => {
    let allowed = true;
    const reader = { readBatch: vi.fn(), validateBatch: vi.fn(() => Promise.resolve(allowed)) };
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      expect(init?.body).toEqual(expect.stringContaining("AUTHORIZED_INPUT")); allowed = false;
      return Promise.resolve(new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 }));
    });
    vi.stubGlobal("fetch", fetch);
    const provider = new OpenAiResponsesChatProvider("https://api.openai.com/v1", "synthetic-key", ["primary", "fallback"], { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2048 });
    const context = await GuardedBackgroundContext.open("summary", [source], reader, () => true);
    await expect(new BackgroundModelGateway(provider).summarize(context)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects an answer derived from sources revoked during generation", async () => {
    const { reader, provider, gateway, deny } = fixture();
    provider.summarizeChannelMessages.mockImplementation(() => { deny(); return Promise.resolve({ facts: [], relations: [] }); });
    const context = await GuardedBackgroundContext.open("summary", [source], reader, () => true);
    await expect(gateway.summarize(context)).rejects.toBeInstanceOf(SocialOutputSuppressed);
  });

  it("bounds a stalled source read and permanently closes the context", async () => {
    vi.useFakeTimers();
    const reader = { readBatch: vi.fn(), validateBatch: vi.fn(() => new Promise<boolean>(() => undefined)) };
    const pending = GuardedBackgroundContext.open("summary", [source], reader, () => true);
    const rejected = expect(pending).rejects.toBeInstanceOf(SocialOutputSuppressed);
    await vi.advanceTimersByTimeAsync(8000); await rejected;
  });
});
