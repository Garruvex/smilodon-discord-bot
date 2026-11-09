import { z } from "zod";
import { reportStructuredUsage, type ChatUsage, type StructuredCallOptions, type StructuredCharacterProvider } from "../../application/chat/chat-provider.js";
import type { TypedDecisionQuestion } from "../../application/chat/typed-decision.js";
import { OpenAiDecisionsClient } from "./openai-decisions-client.js";

const propertySchema = z.union([
  z.object({ type: z.literal("string"), enum: z.array(z.string()).min(1).max(255), description: z.string(),
    "x-choice-descriptions": z.record(z.string()).optional() }),
  z.object({ type: z.literal("boolean"), description: z.string() }),
  z.object({ type: z.literal("number"), minimum: z.literal(0), maximum: z.literal(1), description: z.string() }),
]);
// Simple participation contract: independent questions, one request, and an
// "x-optional" marker for answers whose refusal or malformed data must not void the rest.
const simpleProperty = z.union([
  z.object({ type: z.literal("string"), enum: z.array(z.string()).min(2).max(255), description: z.string(), "x-optional": z.boolean().optional() }),
  z.object({ type: z.literal("number"), minimum: z.literal(0), maximum: z.literal(1), description: z.string(), "x-optional": z.boolean().optional() }),
]);
const simpleSchema = z.object({ "x-native-simple": z.literal(true), properties: z.record(simpleProperty) });
const nativeSchema = z.object({ "x-native-contextual": z.literal(true), properties: z.record(propertySchema) });
export class OpenAiNativeDecisionProvider implements StructuredCharacterProvider {
  public readonly decisionProtocol = "openai-decisions" as const;
  private readonly client: OpenAiDecisionsClient;
  public constructor(config: { baseUrl: string; apiKey: string; model: string }) { this.client = new OpenAiDecisionsClient(config); }
  private async simple(prompt: string, schema: z.infer<typeof simpleSchema>, options?: StructuredCallOptions): Promise<unknown> {
    const questions: TypedDecisionQuestion[] = Object.entries(schema.properties).map(([name, property]) => property.type === "number" ?
      { type: "predicate", name, instructions: property.description, optional: property["x-optional"] === true } :
      { type: "choice", name, instructions: property.description, optional: property["x-optional"] === true, choices: property.enum.map((value) => ({ value })) });
    const result = await this.client.decide(prompt, questions, options);
    return { values: Object.fromEntries(Object.entries(result.answers).map(([key, answer]) => [key, answer.value])),
      confidence: Object.fromEntries(Object.entries(result.answers).map(([key, answer]) => [key, answer.confidence])) };
  }
  public async generateCharacterData(prompt: string, schema: Record<string, unknown>, options?: StructuredCallOptions): Promise<unknown> {
    if (schema["x-native-simple"] === true) return this.simple(prompt, simpleSchema.parse(schema), options);
    const parsed = nativeSchema.parse(schema);
    let usage: ChatUsage | undefined;
    const callOptions: StructuredCallOptions = { ...options, onUsage: (next) => {
      usage = usage ? { inputTokens: usage.inputTokens + next.inputTokens, outputTokens: usage.outputTokens + next.outputTokens,
        totalTokens: usage.totalTokens + next.totalTokens,
        cachedInputTokens: usage.cachedInputTokens === null || next.cachedInputTokens === null ? null : usage.cachedInputTokens + next.cachedInputTokens,
        reasoningTokens: usage.reasoningTokens === null || next.reasoningTokens === null ? null : usage.reasoningTokens + next.reasoningTokens } : next;
      reportStructuredUsage(options, usage);
    } };
    const constants = Object.entries(parsed.properties).filter(([, property]) => property.type === "string" && property.enum.length === 1);
    const questions: TypedDecisionQuestion[] = Object.entries(parsed.properties).filter(([name, property]) => name !== "linkKey" && name !== "targetKey" && (property.type !== "string" || property.enum.length !== 1)).map(([name, property]) =>
      property.type === "number" ? { type: "predicate", name, instructions: property.description } :
        { type: "choice", name, instructions: property.description, choices: property.type === "boolean" ? [{ value: true }, { value: false }] : property.enum.map((item) => ({ value: item, description: property["x-choice-descriptions"]?.[item] })) });
    const result = await this.client.decide(prompt, questions, callOptions);
    const bindings: TypedDecisionQuestion[] = [];
    for (const name of ["linkKey", "targetKey"]) {
      const property = parsed.properties[name];
      if (property?.type !== "string" || name === "targetKey" && property.enum.length === 1) continue;
      const candidates = property.enum.filter((key) => key !== "none");
      const action = result.answers.action?.value;
      const needsBinding = action !== "silent" && (name === "targetKey" || result.answers.relationship?.value === "followup" || candidates.includes("reaction"));
      if (!needsBinding || candidates.length <= 1) {
        // Bind an unambiguous supplied exchange only after the recipient/action
        // classification. No exchange is invented when the source has none.
        result.answers[name] = { value: needsBinding ? candidates[0] ?? "none" : "none", confidence: 1 };
      } else {
        bindings.push({ type: "choice", name, instructions: property.description,
          choices: candidates.map((key) => ({ value: key, description: property["x-choice-descriptions"]?.[key] })) });
      }
    }
    if (bindings.length) {
      const binding = await this.client.decide(`${prompt}\nClassified relationship: ${String(result.answers.relationship?.value)}; action: ${String(result.answers.action?.value)}. Select the supplied destination/exchange supporting that classification.`, bindings, callOptions);
      Object.assign(result.answers, binding.answers);
    }
    return { values: { ...Object.fromEntries(constants.map(([key, property]) => [key, property.type === "string" ? property.enum[0] : null])),
      ...Object.fromEntries(Object.entries(result.answers).map(([key, answer]) => [key, answer.value])) },
      confidence: { ...Object.fromEntries(constants.map(([key]) => [key, 1])),
        ...Object.fromEntries(Object.entries(result.answers).map(([key, answer]) => [key, answer.confidence])) } };
  }
}
