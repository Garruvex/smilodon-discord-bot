import { z } from "zod";
import { layaClassificationSchema, layaQuestionKeys, type LayaClassification, type LayaQuestionKey,
  type layaReplayRequest } from "../../application/chat/laya-contextual-replay.js";

const probability = z.number().finite().min(0).max(1);
const answerSchema = z.object({ type: z.literal("choice"), choice: z.string(), answer_confidence: probability,
  probabilities: z.record(probability) });
const responseSchema = z.object({
  answers: z.record(answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.literal(0),
    state_tokens: z.number().int().nonnegative(), state_tokens_dropped: z.number().int().nonnegative(),
    truncated: z.boolean(), truncated_questions: z.array(z.string()) }),
  routing: z.object({ model: z.string(), repo: z.string() }),
});
const healthSchema = z.object({ status: z.literal("ok"), loaded: z.array(z.string()),
  revisions: z.record(z.string()), checkpoint_devices: z.record(z.string()) });
export type LayaReplayHealth = z.infer<typeof healthSchema>;
export interface LayaReplayPrediction {
  classification: LayaClassification;
  answerConfidence: Record<LayaQuestionKey, number>;
  usage: z.infer<typeof responseSchema>["usage"];
  routing: z.infer<typeof responseSchema>["routing"];
  apiCalls: number;
}
export class LayaReplayError extends Error {
  public readonly code = "invalid_structured_output";
  public constructor(public readonly reason: "http_error" | "checkpoint_mismatch" | "option_mismatch" | "inconsistent_probabilities",
    public readonly status: number | null = null) { super(`Laya replay ${reason}${status === null ? "" : ` (HTTP ${status})`}`); }
}

// Deliberately not a StructuredCharacterProvider. Only the synthetic replay
// runner imports this client; no production routing or generation fallback.
export class LayaReplayClient {
  private readonly baseUrl: string;
  public constructor(private readonly options: { baseUrl: string; apiKey?: string; timeoutMs: number;
    model: "multilingual" | "english" | "typed-decisions"; maxLen: number; headMaxLen: number }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Laya URL must be HTTP(S), without credentials, query or fragment");
    }
    this.baseUrl = url.href.replace(/\/$/u, "");
  }
  public async health(): Promise<LayaReplayHealth> {
    return healthSchema.parse(await this.request("/health"));
  }
  public async predictReply(state: string, question: { type: "choice"; instructions: string; criteria: Record<string, string> }): Promise<{
    choice: "yes" | "no"; confidence: number; usage: LayaReplayPrediction["usage"]; routing: LayaReplayPrediction["routing"];
  }> {
    const result = responseSchema.parse(await this.request("/v1/systemone", { state, questions: { reply: question },
      model: this.options.model, max_len: this.options.maxLen, head_max_len: this.options.headMaxLen }));
    if (result.routing.model !== this.options.model) throw new LayaReplayError("checkpoint_mismatch");
    if (Object.keys(result.answers).join() !== "reply") throw new LayaReplayError("option_mismatch");
    const answer = result.answers.reply!;
    const choice = z.enum(["yes", "no"]).parse(answer.choice);
    if (Object.keys(answer.probabilities).sort().join() !== "no,yes") throw new LayaReplayError("option_mismatch");
    const mass = answer.probabilities.yes! + answer.probabilities.no!;
    const maximum = Math.max(answer.probabilities.yes!, answer.probabilities.no!);
    if (Math.abs(mass - 1) > 0.001 || Math.abs(answer.probabilities[choice]! - maximum) > 0.001 ||
      Math.abs(answer.answer_confidence - maximum) > 0.001) throw new LayaReplayError("inconsistent_probabilities");
    if (result.usage.truncated || result.usage.state_tokens_dropped || result.usage.truncated_questions.length) throw new Error("Reply benchmark input truncated");
    return { choice, confidence: answer.answer_confidence, usage: result.usage, routing: result.routing };
  }
  public async predict(request: ReturnType<typeof layaReplayRequest>, mode: "together" | "separate" = "together"): Promise<LayaReplayPrediction> {
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    const groups = mode === "separate" ? layaQuestionKeys.map((key) => [key]) : [layaQuestionKeys];
    const responses: z.infer<typeof responseSchema>[] = [];
    for (const keys of groups) {
      const questions = Object.fromEntries(keys.map((key) => [key, request.questions[key]]));
      const part = responseSchema.parse(await this.request("/v1/systemone", { state: request.state, questions,
        model: this.options.model, max_len: this.options.maxLen, head_max_len: this.options.headMaxLen }, signal));
      if (JSON.stringify(Object.keys(part.answers).sort()) !== JSON.stringify([...keys].sort())) throw new LayaReplayError("option_mismatch");
      if (part.routing.model !== this.options.model) throw new LayaReplayError("checkpoint_mismatch");
      responses.push(part);
    }
    const first = responses[0]!;
    const result = { ...first, answers: Object.assign({}, ...responses.map((part) => part.answers)) as z.infer<typeof responseSchema>["answers"] };
    if (responses.some((part) => part.routing.repo !== first.routing.repo)) throw new LayaReplayError("checkpoint_mismatch");
    const classification = layaClassificationSchema.parse(Object.fromEntries(layaQuestionKeys.map((key) => [key, result.answers[key]!.choice])));
    if (result.routing.model !== this.options.model) throw new LayaReplayError("checkpoint_mismatch");
    for (const key of layaQuestionKeys) {
      const answer = result.answers[key]!;
      const expected = Object.keys(request.questions[key].criteria).sort();
      if (JSON.stringify(Object.keys(answer.probabilities).sort()) !== JSON.stringify(expected)) throw new LayaReplayError("option_mismatch");
      const mass = Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0);
      const maximum = Math.max(...Object.values(answer.probabilities));
      if (Math.abs(mass - 1) > 0.001 || Math.abs(answer.answer_confidence - maximum) > 0.001
        || Math.abs((answer.probabilities[answer.choice] ?? -1) - maximum) > 0.001) throw new LayaReplayError("inconsistent_probabilities");
    }
    return { classification, answerConfidence: Object.fromEntries(layaQuestionKeys.map((key) => [key, result.answers[key]!.answer_confidence])) as Record<LayaQuestionKey, number>,
      usage: { ...first.usage, input_tokens: responses.reduce((sum, part) => sum + part.usage.input_tokens, 0),
        state_tokens: Math.max(...responses.map((part) => part.usage.state_tokens)),
        state_tokens_dropped: Math.max(...responses.map((part) => part.usage.state_tokens_dropped)),
        truncated: responses.some((part) => part.usage.truncated),
        truncated_questions: [...new Set(responses.flatMap((part) => part.usage.truncated_questions))] },
      routing: result.routing, apiCalls: responses.length };
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { "Content-Type": "application/json", ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(this.options.timeoutMs),
    });
    // Do not log response bodies: a server or proxy can echo credentials/data.
    if (!response.ok) throw new LayaReplayError("http_error", response.status);
    const result: unknown = await response.json();
    return result;
  }
}
