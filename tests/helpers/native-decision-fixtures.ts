import { z } from "zod";
import type { TypedDecisionQuestion } from "../../src/application/chat/typed-decision.js";

export const nativeQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), name: z.string(), instructions: z.string(),
    choices: z.array(z.object({ value: z.union([z.string(), z.boolean()]), description: z.string().optional() })) }),
  z.object({ type: z.literal("predicate"), name: z.string(), instructions: z.string() }),
]);
export function nativeDecisionBody(questions: readonly TypedDecisionQuestion[], overrides: Record<string, string | boolean | number> = {}): {
  model: string; answers: unknown[]; usage: { input_tokens: number; output_tokens: number; total_tokens: number;
    input_tokens_details: { cached_tokens: number }; output_tokens_details: { reasoning_tokens: number } };
} {
  const values: Record<string, string | boolean | number> = { relationship: "followup", intent: "answer", action: "reply", referent: "context_linked",
    opening: "clear", linkKey: "speaker_1", targetKey: "candidate_1", contributionLabel: "answer", reaction: "none", ...overrides };
  return { model: "gpt-6-luna", answers: questions.map((question) => {
    if (question.type === "predicate") return { type: "predicate", name: question.name, probability: overrides[question.name] ?? 0.95 };
    const selected = values[question.name] ?? (question.name.startsWith("evidence_") || question.name === "addsValue" ? true : question.choices[0]!.value);
    return { type: "choice", name: question.name, choice: selected, confidence: 0.99,
      probabilities: question.choices.map((choice) => ({ value: choice.value, probability: choice.value === selected ? 0.99 : 0.01 / (question.choices.length - 1) })) };
  }), usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 0 } } };
}
