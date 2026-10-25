import { afterEach, describe, expect, it, vi } from "vitest";
import { LayaReplayClient } from "../../src/infrastructure/chat/laya-replay-client.js";
import { layaChoiceOptions, layaQuestionKeys, layaReplayRequest } from "../../src/application/chat/laya-contextual-replay.js";
import { contextualReplayCases } from "../../src/application/chat/contextual-replay.js";

function response(): Record<string, unknown> {
  return {
    answers: Object.fromEntries(layaQuestionKeys.map((key) => {
      const options = Object.keys(layaChoiceOptions[key]);
      return [key, { type: "choice", choice: options[0], answer_confidence: 0.8,
        probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 0.8 : 0.2 / (options.length - 1)])) }];
    })),
    usage: { input_tokens: 300, output_tokens: 0, state_tokens: 60, state_tokens_dropped: 0, truncated: false, truncated_questions: [] },
    routing: { model: "multilingual", repo: "convaiinnovations/laya/multilingual" },
  };
}
function client(timeoutMs = 1000): LayaReplayClient {
  return new LayaReplayClient({ baseUrl: "http://localhost:8000/", apiKey: "synthetic-key", model: "multilingual", timeoutMs, maxLen: 8192, headMaxLen: 512 });
}
const request = layaReplayRequest(contextualReplayCases()[0]!);
afterEach(() => vi.unstubAllGlobals());

describe("Laya replay HTTP contract", () => {
  it("uses native typed questions, explicit checkpoint/budgets and bounded transport", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response()));
    vi.stubGlobal("fetch", fetcher);
    const result = await client().predict(request);
    expect(result.classification).toEqual({ relationship: "followup", intent: "answer", action: "reply", referent: "self_contained" });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/v1/systemone");
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer synthetic-key" } });
    expect(options!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options!.body as string)).toEqual({ ...request, model: "multilingual", max_len: 8192, head_max_len: 512 });
  });
  it("preserves truncation diagnostics instead of treating missing context as successful evidence", async () => {
    const body = response();
    body.usage = { input_tokens: 300, output_tokens: 0, state_tokens: 5000, state_tokens_dropped: 100, truncated: true, truncated_questions: ["relationship"] };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)));
    expect((await client().predict(request)).usage).toMatchObject({ truncated: true, state_tokens_dropped: 100 });
  });
  it("evaluates individual questions with one shared deadline and combines their diagnostics", async () => {
    const fetcher = vi.fn<typeof fetch>((_url, options) => {
      const body = JSON.parse(options!.body as string) as { questions: Record<string, unknown> };
      const key = Object.keys(body.questions)[0]!;
      const full = response();
      const answers = full.answers as Record<string, unknown>;
      return Promise.resolve(Response.json({ ...full, answers: { [key]: answers[key] },
        usage: { input_tokens: 300, output_tokens: 0, state_tokens: 60, state_tokens_dropped: key === "intent" ? 2 : 0,
          truncated: key === "intent", truncated_questions: key === "intent" ? [key] : [] } }));
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await client().predict(request, "separate");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.apiCalls).toBe(4);
    expect(result.classification).toEqual({ relationship: "followup", intent: "answer", action: "reply", referent: "self_contained" });
    expect(result.usage).toMatchObject({ input_tokens: 1200, state_tokens: 60, state_tokens_dropped: 2, truncated: true, truncated_questions: ["intent"] });
    expect(new Set(fetcher.mock.calls.map((call) => call[1]!.signal)).size).toBe(1);
  });
  it("rejects missing individual answers rather than filling them with defaults", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...response(), answers: {} }));
    vi.stubGlobal("fetch", fetcher);
    await expect(client().predict(request, "separate")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    { answers: {} },
    { routing: { model: "english", repo: "different" } },
    { usage: { input_tokens: 3, output_tokens: 0 } },
    { answers: { relationship: { type: "choice", choice: "reply", answer_confidence: 1, probabilities: { reply: 1 } } } },
  ])("rejects malformed/strict or wrong-checkpoint responses: %j", async (override) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...response(), ...override })));
    await expect(client().predict(request)).rejects.toThrow();
  });
  it("does not echo a failed response body or retry against a cloud provider", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-token-and-state", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(client().predict(request)).rejects.toMatchObject({ reason: "http_error", status: 503 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("honors the timeout even when an endpoint never responds", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason as Error), { once: true });
    })));
    await expect(client(10).predict(request)).rejects.toThrow();
  });
  it("requires detailed health metadata and rejects credential-bearing URLs", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "ok" })));
    await expect(client().health()).rejects.toThrow();
    expect(() => new LayaReplayClient({ baseUrl: "http://user:secret@localhost", model: "multilingual", timeoutMs: 1000, maxLen: 8192, headMaxLen: 512 })).toThrow();
  });
});
