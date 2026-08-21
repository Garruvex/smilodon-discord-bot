import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiResponsesChatProvider } from "../../src/infrastructure/chat/openai-responses-chat-provider.js";
import type { ChatTool } from "../../src/application/chat/tools/chat-tool.js";

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
      expect(JSON.stringify(body.input)).toContain("REPLY CHAIN IMAGE 1");
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
      ["gpt-5-nano"],
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );
    const response = await provider.reply({
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
      replyChain: [{
        authorId: "22222222222222222", authorDisplayName: "Other", content: "A claim", imageCount: 1,
      }],
      channelHistory: [],
      birthday: null,
      images: [{
        dataUrl: "data:image/png;base64,abc",
        source: "reply_chain",
        sourceIndex: 0,
      }],
      webSearchMode: "auto",
      imageGenerationEnabled: true,
      includeSources: true,
      triggerMode: "direct",
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
      ambientAction: null,
      reactionEmoji: null,
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
      ["gpt-5-nano"],
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );

    const response = await provider.reply({
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
      message: "Draw a cat",
      replyChain: [], channelHistory: [], birthday: null,
      images: [],
      webSearchMode: "off",
      imageGenerationEnabled: true,
      includeSources: false,
      triggerMode: "direct",
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
      ["gpt-5-nano"],
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );
    const response = await provider.reply({
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
      message: "Draw two cats",
      replyChain: [], channelHistory: [], birthday: null,
      images: [],
      webSearchMode: "off",
      imageGenerationEnabled: true,
      includeSources: false,
      triggerMode: "direct",
    });

    expect(response.generatedImages).toHaveLength(2);
    expect(response.generatedImages[0]?.data).toEqual(fakePng("first"));
    expect(response.generatedImages[1]?.data).toEqual(fakePng("second"));
  });

  it("executes a custom tool call and feeds the result back before finalizing", async () => {
    const executeRollDice = vi.fn((args: { sides: number }) =>
      Promise.resolve({ content: JSON.stringify({ sides: args.sides, rolls: [4], total: 4 }) }));
    const rollDiceTool: ChatTool<{ sides: number }> = {
      name: "roll_dice",
      description: "Rolls a die.",
      parameters: { type: "object", additionalProperties: false, required: ["sides"], properties: { sides: { type: "integer" } } },
      execute: executeRollDice,
    };

    let callCount = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      callCount += 1;
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;

      if (callCount === 1) {
        expect(body.tools).toContainEqual({
          type: "function",
          name: "roll_dice",
          description: "Rolls a die.",
          parameters: rollDiceTool.parameters,
          strict: true,
        });
        expect(body.tool_choice).toBe("auto");
        return Promise.resolve(new Response(JSON.stringify({
          output: [{ type: "function_call", call_id: "call_1", name: "roll_dice", arguments: JSON.stringify({ sides: 20 }) }],
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }

      // Second round-trip: the model's function_call plus our function_call_output must be echoed back.
      const input = body.input as Array<Record<string, unknown>>;
      expect(input).toContainEqual({ type: "function_call", call_id: "call_1", name: "roll_dice", arguments: JSON.stringify({ sides: 20 }) });
      expect(input).toContainEqual({ type: "function_call_output", call_id: "call_1", output: JSON.stringify({ sides: 20, rolls: [4], total: 4 }) });
      return Promise.resolve(new Response(JSON.stringify({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ response: "You rolled a 4.", userMemoryActions: [], guildKnowledgeCandidates: [] }) }],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesChatProvider(
      "https://api.openai.com/v1",
      "secret",
      ["gpt-5-nano"],
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );
    const response = await provider.reply({
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
      message: "Roll a d20",
      replyChain: [], channelHistory: [], birthday: null,
      images: [],
      webSearchMode: "off",
      imageGenerationEnabled: false,
      includeSources: false,
      triggerMode: "direct",
      enabledTools: [rollDiceTool],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(executeRollDice).toHaveBeenCalledWith({ sides: 20 }, {
      guildId: "99999999999999999",
      channelId: "77777777777777777",
      currentUser: { id: "11111111111111111", displayName: "Tester", roleNames: [] },
      channelIsNsfw: false,
      isOwner: false,
      music: null,
    });
    expect(response.text).toBe("You rolled a 4.");
  });

  it("forces a real answer once the round-trip cap is hit instead of throwing", async () => {
    const stuckTool: ChatTool<Record<string, never>> = {
      name: "stuck_tool",
      description: "Always asks to be called again.",
      parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
      execute: vi.fn(() => Promise.resolve({ content: "ok" })),
    };
    let callCount = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      callCount += 1;
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as { input: Array<Record<string, unknown>>; tools: unknown[] };
      // maxToolRoundTrips is 6, so requests 1-7 all call the stuck tool
      // (round-trips 0-6) and the 8th request is the forced finalize round:
      // no tools offered, and the last function_call_output must carry the
      // budget-exhausted note.
      if (callCount === 8) {
        expect(body.tools).toEqual([]);
        const lastInputItem = body.input.at(-1);
        expect(lastInputItem).toMatchObject({ type: "function_call_output", call_id: "call_x" });
        expect((lastInputItem as { output: string }).output).toContain("budget exhausted");
        return Promise.resolve(new Response(JSON.stringify({
          output: [{
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify({ response: "Here's what I found so far.", userMemoryActions: [], guildKnowledgeCandidates: [] }) }],
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        output: [{ type: "function_call", call_id: "call_x", name: "stuck_tool", arguments: "{}" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesChatProvider(
      "https://api.openai.com/v1",
      "secret",
      ["gpt-5-nano"],
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );

    const response = await provider.reply({
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
      message: "Do the thing",
      replyChain: [], channelHistory: [], birthday: null,
      images: [],
      webSearchMode: "off",
      imageGenerationEnabled: false,
      includeSources: false,
      triggerMode: "direct",
      enabledTools: [stuckTool],
    });

    // Initial request + 6 tool round-trips + 1 forced finalize round = 8.
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(response.text).toBe("Here's what I found so far.");
  });

  it("uses the configured summary model for analyzeUserCustomization, not the primary reply model", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.model).toBe("gpt-5-nano-cheap");
      return Promise.resolve(new Response(JSON.stringify({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({ ok: true, reason: null, cleanedMarkdown: "- Call me Red\n- Keep it casual" }),
          }],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesChatProvider(
      "https://api.openai.com/v1",
      "secret",
      ["gpt-5-nano"],
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048, summaryModels: ["gpt-5-nano-cheap"] },
    );
    const result = await provider.analyzeUserCustomization("call me Red, keep it casual");

    expect(result).toEqual({ ok: true, markdown: "- Call me Red\n- Keep it casual" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the primary model for analyzeUserCustomization when no summary model is configured", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.model).toBe("gpt-5-nano");
      return Promise.resolve(new Response(JSON.stringify({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({ ok: true, reason: null, cleanedMarkdown: "- Keep it casual" }),
          }],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesChatProvider(
      "https://api.openai.com/v1",
      "secret",
      ["gpt-5-nano"],
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );
    await provider.analyzeUserCustomization("keep it casual");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sizes compilePersonaBundle's output budget off the input length instead of the chat-reply budget", async () => {
    // A file well past the small maxOutputTokens configured below — if the
    // request budget were reused verbatim from chat replies, this personality
    // would truncate mid-JSON and fail to parse (the bug this test guards).
    const largePersonality = "## Voice\n".repeat(2_000);
    let capturedMaxOutputTokens = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      capturedMaxOutputTokens = body.max_output_tokens as number;
      return Promise.resolve(new Response(JSON.stringify({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ core: largePersonality, chunks: [] }) }],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesChatProvider(
      "https://api.openai.com/v1",
      "secret",
      ["gpt-5-nano"],
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );
    const result = await provider.compilePersonaBundle(largePersonality);

    expect(capturedMaxOutputTokens).toBeGreaterThan(2_048);
    expect(result.core).toBe(largePersonality);
  });
});
