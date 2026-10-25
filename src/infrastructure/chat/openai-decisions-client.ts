import { z } from "zod";
import { ChatProviderError, reportStructuredUsage, type StructuredCallOptions } from "../../application/chat/chat-provider.js";
import { nativeDecisionModel, type TypedDecisionAnswer, type TypedDecisionQuestion } from "../../application/chat/typed-decision.js";

const probability = z.number().finite().min(0).max(1);
const value = z.union([z.string(), z.boolean()]);
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("predicate"), name: z.string(), probability }),
  z.object({ type: z.literal("choice"), name: z.string(), choice: value, confidence: probability,
    probabilities: z.array(z.object({ value, probability })).min(2) }),
  z.object({ type: z.literal("refusal"), name: z.string() }),
]);
const usageSchema = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative(), cache_write_tokens: z.number().int().nonnegative().optional() }).optional(),
  output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative() }).optional() });
const responseSchema = z.object({ model: z.string(), answers: z.array(z.unknown()), usage: usageSchema });
export interface OpenAiDecisionResult {
  model: string; answers: Record<string, TypedDecisionAnswer>; usage: z.infer<typeof usageSchema>;
}
export class OpenAiDecisionsClient {
  private readonly url: string;
  public constructor(private readonly config: { baseUrl: string; apiKey: string; model: string }) {
    if (config.model !== nativeDecisionModel) throw new Error(`Native OpenAI Decisions currently requires ${nativeDecisionModel}`);
    const base = new URL(config.baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid Decisions base URL");
    this.url = `${base.href.replace(/\/$/u, "")}/decisions`;
  }
  public async decide(input: string, questions: readonly TypedDecisionQuestion[], options?: StructuredCallOptions): Promise<OpenAiDecisionResult> {
    if (!questions.length || questions.length > 400 || new Set(questions.map((question) => question.name)).size !== questions.length) throw new Error("Invalid decision questions");
    for (const question of questions) if (question.type === "choice" && (question.choices.length < 2 || question.choices.length > 255 ||
      new Set(question.choices.map((choice) => JSON.stringify(choice.value))).size !== question.choices.length)) throw new Error("Invalid decision choices");
    options?.signal?.throwIfAborted(); await options?.beforeAttempt?.(); options?.signal?.throwIfAborted();
    const response = await fetch(this.url, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
      // Native typed inference: no reasoning, verbosity, response_format or generated-text budget.
      body: JSON.stringify({ model: this.config.model, input, questions }), signal: options?.signal ?? AbortSignal.timeout(12_000) });
    if (!response.ok) throw new ChatProviderError(`Decisions endpoint returned HTTP ${response.status}`, response.status, null);
    const body: unknown = await response.json();
    const parsed = responseSchema.parse(body);
    reportStructuredUsage(options, { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens,
      totalTokens: parsed.usage.total_tokens, cachedInputTokens: parsed.usage.input_tokens_details?.cached_tokens ?? null,
      reasoningTokens: parsed.usage.output_tokens_details?.reasoning_tokens ?? null });
    const invalid = (): never => { throw new ChatProviderError("Invalid native decision answer", 502, "invalid_structured_output"); };
    if (parsed.model !== this.config.model || parsed.answers.length !== questions.length) invalid();
    const answers: Record<string, TypedDecisionAnswer> = {};
    const seen = new Set<string>();
    for (const item of parsed.answers) {
      const named = z.object({ name: z.string() }).safeParse(item);
      const question = named.success ? questions.find((candidate) => candidate.name === named.data.name) : undefined;
      if (!question || seen.has(question.name)) invalid();
      seen.add(question!.name);
      // An optional question may be refused or malformed without voiding the
      // other answers; the caller sees it as absent.
      const checked = answerSchema.safeParse(item);
      if (!checked.success) { if (question!.optional) continue; throw checked.error; }
      const answer = checked.data;
      if (answer.type === "refusal" || answer.type !== question!.type) { if (question!.optional) continue; invalid(); }
      if (answer.type === "predicate" && question?.type === "predicate") answers[answer.name] = { value: answer.probability, confidence: Math.max(answer.probability, 1 - answer.probability) };
      else if (answer.type === "choice" && question?.type === "choice") {
        const expected = question.choices.map((choice) => JSON.stringify(choice.value)).sort();
        const actual = answer.probabilities.map((entry) => JSON.stringify(entry.value)).sort();
        const selected = answer.probabilities.find((entry) => entry.value === answer.choice);
        const maximum = Math.max(...answer.probabilities.map((entry) => entry.probability));
        if (JSON.stringify(expected) !== JSON.stringify(actual) || !selected ||
          Math.abs(answer.probabilities.reduce((sum, entry) => sum + entry.probability, 0) - 1) > 0.001 ||
          Math.abs(selected.probability - maximum) > 0.001) { if (question.optional) continue; invalid(); }
        answers[answer.name] = { value: answer.choice, confidence: selected!.probability };
      } else invalid();
    }
    await options?.beforeAttempt?.();
    return { model: parsed.model, answers, usage: parsed.usage };
  }
}
