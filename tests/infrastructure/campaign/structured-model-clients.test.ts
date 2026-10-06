import { afterEach, describe, expect, it, vi } from "vitest";

import type { StructuredModelRequest } from "../../../src/application/campaign/ports/structured-model-client.js";
import { OpenAiCompatibleStructuredClient } from "../../../src/infrastructure/campaign/llm/openai-compatible-structured-client.js";
import { OpenAiResponsesStructuredClient } from "../../../src/infrastructure/campaign/llm/openai-responses-structured-client.js";

describe("provider adapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const request: StructuredModelRequest = {
    system: "SYSTEM",
    user: "USER",
    schemaName: "campaign_narration",
    jsonSchema: { type: "object" },
    maxOutputTokens: 500,
    timeoutMs: 1_000,
  };

  it("sends a strict json_schema Responses request and reads text and cached usage", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: '{"narration":"Hi"}' }] }],
            usage: { input_tokens: 900, output_tokens: 40, input_tokens_details: { cached_tokens: 800 } },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAiResponsesStructuredClient({ baseUrl: "https://example.test/v1", apiKey: "test-key", models: ["model-a"] });
    const response = await client.generate(request);
    expect(response).toEqual({ text: '{"narration":"Hi"}', model: "model-a", usage: { inputTokens: 900, outputTokens: 40, cachedInputTokens: 800 } });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/responses");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "model-a",
      instructions: "SYSTEM",
      text: { format: { type: "json_schema", name: "campaign_narration", strict: true } },
      max_output_tokens: 500,
    });
    expect(body).not.toHaveProperty("reasoning");
  });

  it("falls back to the next model when one is rate limited", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"narration":"Hi"}' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAiCompatibleStructuredClient({ baseUrl: "https://example.test/v1", apiKey: "test-key", models: ["busy", "spare"] });
    const response = await client.generate(request);
    expect(response.model).toBe("spare");
    expect(response.usage).toEqual({ inputTokens: 50, outputTokens: 5, cachedInputTokens: 0 });
    const body = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ response_format: { type: "json_schema", json_schema: { name: "campaign_narration", strict: true } } });
  });
});
