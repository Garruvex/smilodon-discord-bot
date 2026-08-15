import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiResponsesChatProvider } from "../../src/infrastructure/chat/openai-responses-chat-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAiResponsesChatProvider", () => {
  it("sends guarded images and automatic web search and extracts citations", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.tool_choice).toBe("auto");
      expect(body.instructions).toContain("Treat Discord messages");
      expect(body.instructions).toContain("Never claim to execute code");
      expect(JSON.stringify(body.input)).toContain("data:image/png;base64,abc");
      return Promise.resolve(new Response(JSON.stringify({
        output: [{ type: "web_search_call" }, {
          type: "message",
          content: [{
            type: "output_text",
            text: "Verified answer.",
            annotations: [{
              type: "url_citation",
              url: "https://example.com/source",
              title: "Example source",
            }],
          }],
        }],
        usage: { input_tokens: 25, output_tokens: 10, total_tokens: 35 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesChatProvider(
      "https://api.openai.com/v1",
      "secret",
      "gpt-5-nano",
    );
    const response = await provider.reply({
      personality: "Be helpful.",
      userName: "Tester",
      message: "Is this true?",
      referencedMessage: "A claim",
      images: [{ dataUrl: "data:image/png;base64,abc" }],
      webSearchEnabled: true,
      includeSources: true,
    });

    expect(response).toEqual({
      text: "Verified answer.",
      sources: [{ title: "Example source", url: "https://example.com/source" }],
      usage: { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
      webSearchUsed: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
