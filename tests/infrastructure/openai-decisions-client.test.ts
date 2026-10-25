import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiDecisionsClient } from "../../src/infrastructure/chat/openai-decisions-client.js";
import { nativeDecisionBody } from "../helpers/native-decision-fixtures.js";
import type { TypedDecisionQuestion } from "../../src/application/chat/typed-decision.js";

const questions: TypedDecisionQuestion[] = [{ type: "choice", name: "relationship", instructions: "Who is addressed?",
  choices: [{ value: "followup", description: "The bot" }, { value: "elsewhere", description: "Another human" }] },
{ type: "predicate", name: "useful", instructions: "Is this useful?" }];
const client = (): OpenAiDecisionsClient => new OpenAiDecisionsClient({ baseUrl: "https://api.openai.com/v1", apiKey: "synthetic-key", model: "gpt-6-luna" });
afterEach(() => vi.unstubAllGlobals());
describe("native OpenAI Decisions transport", () => {
  it("posts typed questions to /decisions without generation or reasoning settings", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(nativeDecisionBody(questions)));
    vi.stubGlobal("fetch", fetcher);
    const onUsage = vi.fn();
    const result = await client().decide("Synthetic conversation", questions, { onUsage });
    expect(result.answers).toEqual({ relationship: { value: "followup", confidence: 0.99 }, useful: { value: 0.95, confidence: 0.95 } });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/decisions");
    expect(JSON.parse(request!.body as string)).toEqual({ model: "gpt-6-luna", input: "Synthetic conversation", questions });
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 0, totalTokens: 100, cachedInputTokens: 20, reasoningTokens: 0 });
  });
  it.each(["refusal", "missing", "duplicate", "unknown", "wrong_choice", "wrong_model"])("rejects %s answers without retries", async (kind) => {
    const body = nativeDecisionBody(questions);
    if (kind === "refusal") body.answers[0] = { type: "refusal", name: "relationship" };
    if (kind === "missing") body.answers.pop();
    if (kind === "duplicate") body.answers[1] = body.answers[0];
    if (kind === "unknown") body.answers[1] = { type: "predicate", name: "unknown", probability: 0.9 };
    if (kind === "wrong_choice") body.answers[0] = { type: "choice", name: "relationship", choice: "outsider", confidence: 1,
      probabilities: [{ value: "outsider", probability: 1 }, { value: "elsewhere", probability: 0 }] };
    if (kind === "wrong_model") body.model = "gpt-5-nano";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)); vi.stubGlobal("fetch", fetcher);
    await expect(client().decide("Synthetic", questions)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("honors admission failure and abort before sending anything", async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
    await expect(client().decide("Synthetic", questions, { beforeAttempt: () => Promise.reject(new Error("source invalidated")) })).rejects.toThrow();
    await expect(client().decide("Synthetic", questions, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves HTTP status without echoing response bodies or falling back", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("SECRET_SENTINEL", { status: 429 })); vi.stubGlobal("fetch", fetcher);
    await expect(client().decide("Synthetic", questions)).rejects.toMatchObject({ status: 429, message: "Decisions endpoint returned HTTP 429" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("optional native questions", () => {
  const simple: TypedDecisionQuestion[] = [
    { type: "choice", name: "action", instructions: "Act?", choices: [{ value: "reply" }, { value: "ignore" }] },
    { type: "choice", name: "emoji", instructions: "Emoji?", optional: true, choices: [{ value: "👍" }, { value: "none" }] }];
  const run = async (mutate: (body: ReturnType<typeof nativeDecisionBody>) => void): Promise<Awaited<ReturnType<OpenAiDecisionsClient["decide"]>>> => {
    const body = nativeDecisionBody(simple); mutate(body);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)));
    return client().decide("Synthetic", simple);
  };
  it("treats a refused or malformed optional answer as absent without voiding the required one", async () => {
    for (const mutate of [
      (body: ReturnType<typeof nativeDecisionBody>): void => { body.answers[1] = { type: "refusal", name: "emoji" }; },
      (body: ReturnType<typeof nativeDecisionBody>): void => { body.answers[1] = { type: "choice", name: "emoji", choice: "🦄", confidence: 1, probabilities: [{ value: "🦄", probability: 1 }, { value: "none", probability: 0 }] }; },
      (body: ReturnType<typeof nativeDecisionBody>): void => { body.answers[1] = { type: "choice", name: "emoji", choice: "👍" }; },
    ]) {
      const result = await run(mutate);
      expect(Object.keys(result.answers)).toEqual(["action"]);
    }
  });
  it("still rejects a refused required answer, a duplicate or a missing answer", async () => {
    await expect(run((body) => { body.answers[0] = { type: "refusal", name: "action" }; })).rejects.toThrow();
    await expect(run((body) => { body.answers[1] = body.answers[0]; })).rejects.toThrow();
    await expect(run((body) => { body.answers.pop(); })).rejects.toThrow();
  });
});
