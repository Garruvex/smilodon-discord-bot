import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiResponsesChatProvider } from "../../src/infrastructure/chat/openai-responses-chat-provider.js";
import { GeminiChatProvider } from "../../src/infrastructure/chat/gemini-chat-provider.js";

const generateContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(function FakeGoogleGenAI(this: { models: { generateContent: typeof generateContentMock } }) {
    this.models = { generateContent: generateContentMock };
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  generateContentMock.mockReset();
});

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function fakePng(payload: string): Buffer {
  return Buffer.concat([pngSignature, Buffer.from(payload)]);
}

const reference = { data: Buffer.from("reference-bytes"), contentType: "image/png" };

describe("OpenAiResponsesChatProvider.generateReferenceImage", () => {
  it("sends the reference image and prompt, forces the image tool, and decodes the result", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.tools).toEqual([{ type: "image_generation" }]);
      expect(body.tool_choice).toBe("required");
      const referenceDataUrl = `data:image/png;base64,${reference.data.toString("base64")}`;
      expect(JSON.stringify(body.input)).toContain(referenceDataUrl);
      expect(JSON.stringify(body.input)).toContain("waving happily");
      return Promise.resolve(new Response(JSON.stringify({
        output: [{ type: "image_generation_call", result: fakePng("self-portrait").toString("base64") }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesChatProvider(
      "https://api.openai.com/v1",
      "secret",
      ["gpt-5-nano"],
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );

    const result = await provider.generateReferenceImage("waving happily", reference);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.contentType).toBe("image/png");
    }
  });

  it("reports a failure reason instead of throwing when no image comes back", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ output: [] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }))));
    const provider = new OpenAiResponsesChatProvider(
      "https://api.openai.com/v1", "secret", ["gpt-5-nano"],
      { reasoningEffort: "low", verbosity: "low", maxOutputTokens: 2_048 },
    );

    const result = await provider.generateReferenceImage("waving", reference);

    expect(result.ok).toBe(false);
  });
});

describe("GeminiChatProvider.generateReferenceImage", () => {
  it("sends the reference image and prompt with responseModalities, and decodes the result", async () => {
    generateContentMock.mockResolvedValue({
      candidates: [{
        content: {
          parts: [{ inlineData: { data: fakePng("self-portrait").toString("base64"), mimeType: "image/png" } }],
        },
      }],
    });

    const provider = new GeminiChatProvider("secret", ["gemini-test"], { maxOutputTokens: 2048, thinkingBudget: null });

    const result = await provider.generateReferenceImage("waving happily", reference);

    expect(generateContentMock).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ responseModalities: ["TEXT", "IMAGE"] }) as unknown,
    }));
    const callArgs = generateContentMock.mock.calls[0]?.[0] as { contents: unknown };
    expect(JSON.stringify(callArgs.contents)).toContain(reference.data.toString("base64"));
    expect(JSON.stringify(callArgs.contents)).toContain("waving happily");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.images).toHaveLength(1);
  });

  it("reports a failure reason instead of throwing when no image comes back", async () => {
    generateContentMock.mockResolvedValue({ candidates: [{ content: { parts: [] } }] });

    const provider = new GeminiChatProvider("secret", ["gemini-test"], { maxOutputTokens: 2048, thinkingBudget: null });

    const result = await provider.generateReferenceImage("waving", reference);

    expect(result.ok).toBe(false);
  });
});
