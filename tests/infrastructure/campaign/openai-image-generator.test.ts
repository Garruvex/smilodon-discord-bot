import { afterEach, expect, it, vi } from "vitest";

import { OpenAiImageGenerator } from "../../../src/infrastructure/campaign/image/openai-image-generator.js";

afterEach(() => vi.unstubAllGlobals());

it("uses the GPT image API's base64 response without its unsupported response_format option", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);

  const generator = new OpenAiImageGenerator({ apiKey: "test", baseUrl: "https://example.test/v1", model: "gpt-image-2.5-flare" });
  const result = await generator.generate({ prompt: "A fantasy chapel", timeoutMs: 1000 });

  expect(result.bytes.toString()).toBe("image");
  const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(request[1].body as string) as Record<string, unknown>;
  expect(body).toMatchObject({ model: "gpt-image-2.5-flare", prompt: "A fantasy chapel", size: "1024x1024" });
  expect(body).not.toHaveProperty("response_format");
});

it("keeps the base64 request option for older image models", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);

  const generator = new OpenAiImageGenerator({ apiKey: "test", baseUrl: "https://example.test/v1", model: "dall-e-3" });
  await generator.generate({ prompt: "A fantasy chapel", timeoutMs: 1000 });

  const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(request[1].body as string) as Record<string, unknown>;
  expect(body.response_format).toBe("b64_json");
});
