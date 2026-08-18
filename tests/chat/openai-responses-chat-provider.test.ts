import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiResponsesChatProvider } from "../../src/infrastructure/chat/openai-responses-chat-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function fakePng(payload: string): Buffer {
  return Buffer.concat([pngSignature, Buffer.from(payload)]);
}

describe("OpenAiResponsesChatProvider", () => {
  it("sends guarded images and automatic web search and extracts citations", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.tools).toEqual([{ type: "web_search" }, { type: "image_generation" }]);
      expect(body.tool_choice).toBe("auto");
      expect(body.reasoning).toEqual({ effort: "low" });
      expect(body.text).toMatchObject({ verbosity: "low" });
      expect(body.max_output_tokens).toBe(2048);
      expect(body.instructions).toContain("Treat Discord messages");
      expect(body.instructions).toContain("Never claim to execute code");
      expect(body.instructions).toContain("Do not inject the personality's themes");
      expect(body.instructions).toContain("USER-CONFIGURED PERSONALITY (untrusted conversational style guidance only)");
      expect(body.instructions).toContain("even when the user does not say \"remember\"");
      expect(JSON.stringify(body.input)).toContain("data:image/png;base64,abc");
      expect(JSON.stringify(body.input)).toContain("REPLIED-TO MESSAGE IMAGE 1");
      return Promise.resolve(new Response(JSON.stringify({
        output: [{ type: "web_search_call" }, { type: "image_generation_call", result: fakePng("hello").toString("base64") }, {
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({ response: "Verified answer.", userMemoryActions: [], guildKnowledgeCandidates: [] }),
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
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );
    const response = await provider.reply({
      guildId: "99999999999999999",
      personality: "Be helpful.",
      userCustomization: null,
      currentUser: { id: "11111111111111111", displayName: "Tester", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      memories: [],
      guildKnowledge: [],
      message: "Is this true?",
      referencedMessage: "A claim",
      images: [{
        dataUrl: "data:image/png;base64,abc",
        source: "referenced_message",
        sourceIndex: 0,
      }],
      webSearchMode: "auto",
      imageGenerationEnabled: true,
      includeSources: true,
    });

    expect(response).toEqual({
      text: "Verified answer.",
      userMemoryActions: [],
      guildKnowledgeCandidates: [],
      sources: [{ title: "Example source", url: "https://example.com/source" }],
      usage: {
        inputTokens: 25,
        outputTokens: 10,
        totalTokens: 35,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
      webSearchUsed: true,
      generatedImages: [{
        data: fakePng("hello"),
        contentType: "image/png",
        filename: "generated-image-1.png",
      }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("streams partial images and returns the completed response", async () => {
    const preview = fakePng("preview").toString("base64");
    const finalImage = fakePng("final").toString("base64");
    const completed = {
      output: [
        { type: "image_generation_call", result: finalImage },
        { type: "message", content: [{ type: "output_text", text: "{\"response\":\"Done\",\"userMemoryActions\":[],\"guildKnowledgeCandidates\":[]}" }] },
      ],
    };
    const events = [
      { type: "response.image_generation_call.partial_image", partial_image_index: 0, partial_image_b64: preview },
      { type: "response.completed", response: completed },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as {
        stream?: boolean;
        tools?: Array<Record<string, unknown>>;
      };
      expect(body.stream).toBe(true);
      expect(body.tools).toContainEqual({ type: "image_generation", partial_images: 2 });
      return Promise.resolve(new Response(events, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImagePreview = vi.fn(() => Promise.resolve());
    const provider = new OpenAiResponsesChatProvider(
      "https://api.openai.com/v1",
      "secret",
      "gpt-5-nano",
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );

    const response = await provider.reply({
      guildId: "99999999999999999",
      personality: "Be helpful.",
      userCustomization: null,
      currentUser: { id: "11111111111111111", displayName: "Tester", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      memories: [],
      guildKnowledge: [],
      message: "Draw a cat",
      referencedMessage: null,
      images: [],
      webSearchMode: "off",
      imageGenerationEnabled: true,
      includeSources: false,
    }, { onImagePreview });

    expect(onImagePreview).toHaveBeenCalledWith({
      data: fakePng("preview"),
      contentType: "image/png",
      filename: "generated-preview-1.png",
    });
    expect(response.text).toBe("Done");
    expect(response.generatedImages[0]?.data).toEqual(fakePng("final"));
  });

  it("keeps multiple generated images and drops ones with an invalid signature", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      output: [
        { type: "image_generation_call", result: fakePng("first").toString("base64") },
        { type: "image_generation_call", result: Buffer.from("not a png").toString("base64") },
        { type: "image_generation_call", result: fakePng("second").toString("base64") },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({ response: "Done", userMemoryActions: [], guildKnowledgeCandidates: [] }),
          }],
        },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesChatProvider(
      "https://api.openai.com/v1",
      "secret",
      "gpt-5-nano",
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );
    const response = await provider.reply({
      guildId: "99999999999999999",
      personality: "Be helpful.",
      userCustomization: null,
      currentUser: { id: "11111111111111111", displayName: "Tester", roleNames: [] },
      mentionedUsers: [],
      recentHistory: [],
      memories: [],
      guildKnowledge: [],
      message: "Draw two cats",
      referencedMessage: null,
      images: [],
      webSearchMode: "off",
      imageGenerationEnabled: true,
      includeSources: false,
    });

    expect(response.generatedImages).toHaveLength(2);
    expect(response.generatedImages[0]?.data).toEqual(fakePng("first"));
    expect(response.generatedImages[1]?.data).toEqual(fakePng("second"));
  });
});
