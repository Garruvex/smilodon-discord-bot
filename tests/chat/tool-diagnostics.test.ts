import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiResponsesChatProvider } from "../../src/infrastructure/chat/openai-responses-chat-provider.js";
import { GeminiChatProvider } from "../../src/infrastructure/chat/gemini-chat-provider.js";
import { instrumentModel } from "../../src/application/diagnostics/model-diagnostics.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "../../src/application/chat/tools/chat-tool.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

afterEach(() => vi.useRealTimers());
describe.each(["responses", "gemini"])("%s tool diagnostics", (kind) => {
  function setup(execute: () => Promise<ChatToolResult>, known = true): { provider: { reply: () => Promise<ChatToolResult> }; records: Record<string, unknown>[] } {
    const { logger, records } = captureDiagnosticLogger();
    const raw = kind === "responses" ? new OpenAiResponsesChatProvider("https://example.test", "secret", ["model"], { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 100 })
      : new GeminiChatProvider("secret", ["model"], { maxOutputTokens: 100, thinkingBudget: null });
    // Exercise the real provider's tool boundary without a model/network call.
    const boundary = raw as unknown as { executeToolCall(call: unknown, tools: readonly ChatTool[], ctx: ChatToolContext): Promise<ChatToolResult> };
    const tool: ChatTool = { name: "test", description: "SECRET", parameters: {}, execute };
    const provider = instrumentModel({ reply: () => boundary.executeToolCall({ name: "test", arguments: "{}", args: {} }, known ? [tool] : [], {} as ChatToolContext) }, logger);
    return { provider, records };
  }
  it("reports completed, rejected and unknown tools without payloads", async () => {
    for (const status of ["completed", "failed", "unknown_tool"]) {
      const { provider, records } = setup(() => status === "failed" ? Promise.reject(new Error("SECRET")) : Promise.resolve({ content: "SECRET" }), status !== "unknown_tool");
      await provider.reply();
      expect(records).toContainEqual(expect.objectContaining({ event: "chat.tool.completed", status }));
      expect(JSON.stringify(records)).not.toContain("SECRET");
    }
  });
  it("reports a timed-out tool once even when it eventually settles", async () => {
    vi.useFakeTimers();
    let release!: (result: ChatToolResult) => void;
    const { provider, records } = setup(() => new Promise((resolve) => { release = resolve; }));
    const result = provider.reply();
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
    release({ content: "SECRET" }); await Promise.resolve();
    expect(records.filter((record) => record.event === "chat.tool.completed")).toEqual([expect.objectContaining({ status: "timeout" })]);
  });
});
