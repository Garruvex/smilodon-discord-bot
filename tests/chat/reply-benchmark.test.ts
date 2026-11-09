import { afterEach, describe, expect, it, vi } from "vitest";
import { replyBenchmarkCase, replyBenchmarkMetrics, replyQuestion, contextualReplyQuestion } from "../../src/application/chat/reply-benchmark.js";
import { contextualReplayCases } from "../../src/application/chat/contextual-replay.js";
import { LayaReplayClient } from "../../src/infrastructure/chat/laya-replay-client.js";
import { OpenAiDecisionsClient } from "../../src/infrastructure/chat/openai-decisions-client.js";
import { nativeDecisionBody, nativeQuestionSchema } from "../helpers/native-decision-fixtures.js";
import { z } from "zod";

afterEach(() => vi.unstubAllGlobals());
describe("binary reply benchmark", () => {
  it("separates optional replies from ground truth and never places labels in input", () => {
    const fixtures = contextualReplayCases();
    const samples = fixtures.map(replyBenchmarkCase);
    expect(samples.filter((sample) => sample.expected === null)).toHaveLength(54);
    expect(samples.filter((sample) => sample.expected === "yes")).toHaveLength(72);
    for (const [index, sample] of samples.entries()) {
      const fixture = fixtures[index]!;
      expect(sample.state).not.toContain(fixture.id);
      expect(sample.state).not.toContain("expected");
      const input = z.object({ currentMessageId: z.string(), messages: z.array(z.object({ speakerId: z.string(), text: z.string() })) }).parse(JSON.parse(sample.state) as unknown);
      expect(input.currentMessageId).toBe(fixture.current.messageId);
      expect(input.messages.at(-1)).toMatchObject({ speakerId: fixture.current.authorId, text: fixture.current.content });
    }
  });
  it("counts failed Yes cases separately from predicted No and does not reward always-silent predictions", () => {
    const base = { durationMs: 10, status: "valid" };
    expect(replyBenchmarkMetrics([
      { ...base, expected: "yes", prediction: "yes" }, { ...base, expected: "no", prediction: "yes" },
      { ...base, expected: "yes", prediction: "no" }, { ...base, expected: "no", prediction: "no" },
      { ...base, expected: "yes", prediction: null, status: "failed" },
      { ...base, expected: null, prediction: null, status: "review_required" },
    ])).toMatchObject({ labeled: 5, reviewRequired: 1, failed: 1, truePositives: 1, trueNegatives: 1,
      unwantedReplies: 1, missedReplies: 1, accuracyAllLabeled: 0.4, precision: 0.5, recall: 0.5 });
  });
  it.each([replyQuestion, contextualReplyQuestion])("sends exactly one equivalent yes/no question to both endpoints", async (question) => {
    const state = replyBenchmarkCase(contextualReplayCases()[0]!).state;
    const laya = new LayaReplayClient({ baseUrl: "http://localhost:8000", timeoutMs: 1000, model: "multilingual", maxLen: 8192, headMaxLen: 512 });
    const openai = new OpenAiDecisionsClient({ baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic", model: "gpt-6-luna" });
    const fetcher = vi.fn<typeof fetch>((url, request) => {
      const raw: unknown = JSON.parse(request!.body as string);
      const endpoint = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (endpoint.endsWith("/decisions")) {
        const body = z.object({ input: z.string(), questions: z.array(nativeQuestionSchema) }).parse(raw);
        expect(body.input).toBe(state);
        expect(body.questions).toEqual([{ type: "choice", name: "reply", instructions: question.instructions,
          choices: [{ value: "yes", description: question.criteria.yes }, { value: "no", description: question.criteria.no }] }]);
        return Promise.resolve(Response.json(nativeDecisionBody(body.questions, { reply: "yes" })));
      }
      expect(raw).toMatchObject({ state, questions: { reply: question } });
      expect(Object.keys(z.object({ questions: z.record(z.unknown()) }).parse(raw).questions)).toEqual(["reply"]);
      return Promise.resolve(Response.json({ answers: { reply: { type: "choice", choice: "yes", answer_confidence: 0.6, probabilities: { yes: 0.6, no: 0.4 } } },
        routing: { model: "multilingual", repo: "synthetic" }, usage: { input_tokens: 10, output_tokens: 0,
          state_tokens: 10, state_tokens_dropped: 0, truncated: false, truncated_questions: [] } }));
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await laya.predictReply(state, question)).choice).toBe("yes");
    expect((await openai.decide(state, [{ type: "choice", name: "reply", instructions: question.instructions,
      choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })) }])).answers.reply?.value).toBe("yes");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
