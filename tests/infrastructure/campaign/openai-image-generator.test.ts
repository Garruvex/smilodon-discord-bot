import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageProviderError } from "../../../src/application/campaign/ports/image-ports.js";
import { OpenAiImageGenerator } from "../../../src/infrastructure/campaign/image/openai-image-generator.js";
import { pngBytes } from "../../application/campaign/portrait-fakes.js";

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
const picture = { data: [{ b64_json: pngBytes.toString("base64") }] };
const bodyOf = (fetch: ReturnType<typeof vi.fn>): Record<string, unknown> => JSON.parse(((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)) as Record<string, unknown>;

describe("the campaign's image request", () => {
  it("uses the GPT image API's base64 response without its unsupported response_format option", async () => {
    const fetch = vi.fn().mockResolvedValue(answer(200, picture));
    vi.stubGlobal("fetch", fetch);
    const generator = new OpenAiImageGenerator({ apiKey: "test", baseUrl: "https://example.test/v1", model: "gpt-image-2.5-flare" });
    const result = await generator.generate({ prompt: "A fantasy chapel", timeoutMs: 1000 });
    expect(result.bytes.equals(pngBytes)).toBe(true);
    expect(result.mediaType).toBe("image/png");
    expect(bodyOf(fetch)).toMatchObject({ model: "gpt-image-2.5-flare", prompt: "A fantasy chapel", size: "1024x1024" });
    expect(bodyOf(fetch)).not.toHaveProperty("response_format");
    expect(bodyOf(fetch)).not.toHaveProperty("quality");
  });

  it("keeps the base64 request option for older image models", async () => {
    const fetch = vi.fn().mockResolvedValue(answer(200, picture));
    vi.stubGlobal("fetch", fetch);
    await new OpenAiImageGenerator({ apiKey: "test", baseUrl: "https://example.test/v1", model: "dall-e-3" }).generate({ prompt: "A fantasy chapel", timeoutMs: 1000 });
    expect(bodyOf(fetch).response_format).toBe("b64_json");
  });

  it("asks for a wide picture where the model has one, and a square where it does not know", async () => {
    const sizes: string[] = [];
    for (const [model, aspect] of [
      ["gpt-image-1", "wide"],
      ["gpt-image-1", "tall"],
      ["dall-e-3", "wide"],
      ["some-other-model", "wide"],
      ["gpt-image-1", "square"],
    ] as const) {
      const fetch = vi.fn().mockResolvedValue(answer(200, picture));
      vi.stubGlobal("fetch", fetch);
      await new OpenAiImageGenerator({ apiKey: "k", baseUrl: "https://example.test/v1", model }).generate({ prompt: "p", aspect, timeoutMs: 1000 });
      sizes.push(String(bodyOf(fetch).size));
    }
    expect(sizes).toEqual(["1536x1024", "1024x1536", "1792x1024", "1024x1024", "1024x1024"]);
  });

  it("sends a fixed size and a quality only when they were configured, and only to a GPT image model", async () => {
    const fetch = vi.fn().mockResolvedValue(answer(200, picture));
    vi.stubGlobal("fetch", fetch);
    await new OpenAiImageGenerator({ apiKey: "k", baseUrl: "https://example.test/v1", model: "gpt-image-1", size: "1024x1024", quality: "low" }).generate({ prompt: "p", aspect: "wide", timeoutMs: 1000 });
    expect(bodyOf(fetch)).toMatchObject({ size: "1024x1024", quality: "low" });
    const older = vi.fn().mockResolvedValue(answer(200, picture));
    vi.stubGlobal("fetch", older);
    await new OpenAiImageGenerator({ apiKey: "k", baseUrl: "https://example.test/v1", model: "dall-e-3", quality: "low" }).generate({ prompt: "p", timeoutMs: 1000 });
    expect(bodyOf(older)).not.toHaveProperty("quality");
  });

  it("never sends more than the prompt limit", async () => {
    const fetch = vi.fn().mockResolvedValue(answer(200, picture));
    vi.stubGlobal("fetch", fetch);
    await new OpenAiImageGenerator({ apiKey: "k", baseUrl: "https://example.test/v1", model: "gpt-image-1" }).generate({ prompt: "x".repeat(9_000), timeoutMs: 1000 });
    expect(String(bodyOf(fetch).prompt).length).toBe(3_800);
  });

  it("sends saved party portraits as image references for a wide scene", async () => {
    const fetch = vi.fn().mockResolvedValue(answer(200, picture));
    vi.stubGlobal("fetch", fetch);
    await new OpenAiImageGenerator({ apiKey: "k", baseUrl: "https://example.test/v1", model: "gpt-image-1" }).generate({
      prompt: "Luna enters the inn",
      aspect: "wide",
      timeoutMs: 1000,
      references: [{ name: "Luna", image: { bytes: pngBytes, mediaType: "image/png" } }],
    });
    const [url, options] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/images/edits");
    expect(options.body).toBeInstanceOf(FormData);
    const form = options.body as FormData;
    expect(form.get("size")).toBe("1536x1024");
    expect(form.get("prompt")).toBe("Luna enters the inn");
    expect(form.getAll("image[]")).toHaveLength(1);
  });
});

describe("what the provider says back", () => {
  const generate = async (response: Response): Promise<unknown> => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    return new OpenAiImageGenerator({ apiKey: "k", baseUrl: "https://example.test/v1", model: "gpt-image-1" }).generate({ prompt: "p", timeoutMs: 1000 }).catch((error: unknown) => error);
  };

  it("says a refusal will not pass, and keeps the reason without any key in it", async () => {
    const error = await generate(answer(400, { error: { code: "moderation_blocked", message: "Rejected by the safety system, key sk-abc123XYZ" } }));
    expect(error).toBeInstanceOf(ImageProviderError);
    expect((error as ImageProviderError).retryable).toBe(false);
    expect((error as Error).message).toContain("moderation_blocked");
    expect((error as Error).message).not.toContain("sk-abc123XYZ");
  });

  it("says a rate limit or a server error may pass", async () => {
    expect(((await generate(answer(429, {}))) as ImageProviderError).retryable).toBe(true);
    expect(((await generate(answer(503, {}))) as ImageProviderError).retryable).toBe(true);
  });

  it("refuses an answer that is not a picture", async () => {
    const error = (await generate(answer(200, { data: [{ b64_json: Buffer.from("<html>oops</html>").toString("base64") }] }))) as ImageProviderError;
    expect(error.message).toContain("not a picture");
    expect(((await generate(answer(200, { data: [] }))) as ImageProviderError).message).toContain("no picture");
  });
});

describe("apart from the chat", () => {
  it("is built from the campaign's own settings only", () => {
    // The generator takes its key, address and model as options and reads no environment or chat setting.
    expect(new OpenAiImageGenerator({ apiKey: "k", baseUrl: "https://images.test/v1", model: "m" })).toBeDefined();
  });
});
