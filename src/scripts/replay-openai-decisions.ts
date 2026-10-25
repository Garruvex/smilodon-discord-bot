import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { contextualReplayCases } from "../application/chat/contextual-replay.js";
import { assessLayaClassification, layaClassificationSchema, layaQuestionKeys, layaReplayRequest, layaReplayRevision,
  type LayaClassification, type LayaReplayVariant } from "../application/chat/laya-contextual-replay.js";
import { syntheticReplayContext } from "../application/chat/synthetic-replay-context.js";
import { GuardedConversationContext } from "../application/chat/guarded-conversation-context.js";
import { safeFailure } from "../application/diagnostics/chat-diagnostics.js";
import { loadInstanceEnvironment } from "../config/instance-environment.js";
import { OpenAiDecisionsClient } from "../infrastructure/chat/openai-decisions-client.js";
import type { TypedDecisionAnswer, TypedDecisionQuestion } from "../application/chat/typed-decision.js";
import type { ChatUsage } from "../application/chat/chat-provider.js";

interface Result {
  id: string; language: string; scenario: string; status: "valid" | "failed" | "not_run"; durationMs: number;
  classification?: LayaClassification; relationshipCorrect?: boolean; disallowedReply?: boolean;
  confidence?: Record<string, number>; failure?: ReturnType<typeof safeFailure>; usage: ChatUsage[]; apiCalls: number;
}
function metrics(rows: readonly Result[]): Record<string, number | null> {
  const times = rows.filter((row) => row.status === "valid").map((row) => row.durationMs).sort((a, b) => a - b);
  return { cases: rows.length, valid: times.length, failed: rows.filter((row) => row.status === "failed").length,
    correctRelationships: rows.filter((row) => row.relationshipCorrect).length,
    relationshipAccuracyAllCases: rows.length ? rows.filter((row) => row.relationshipCorrect).length / rows.length : null,
    replyProposalsOnDisallowedCases: rows.filter((row) => row.disallowedReply).length,
    replyProposals: rows.filter((row) => row.classification?.action === "reply").length,
    p50Ms: times.length ? times[Math.floor(times.length * 0.5)]! : null,
    p95Ms: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]! : null };
}
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { help: { type: "boolean" }, live: { type: "boolean" }, instance: { type: "string" },
    format: { type: "string" }, choices: { type: "string" }, questions: { type: "string" },
    limit: { type: "string" }, language: { type: "string" }, scenario: { type: "string" }, output: { type: "string" }, "timeout-ms": { type: "string" } } });
  if (values.help) {
    process.stdout.write("Usage: node node_modules/tsx/dist/cli.mjs src/scripts/replay-openai-decisions.ts [--live --instance pinecone] [--format json|dialogue] [--choices detailed|short] [--questions together|separate] [--limit 216] [--language zh-TW|en|ja] [--scenario answer] [--timeout-ms 60000] [--output data/evaluations/openai-decisions-classification.json]\nInventory by default. Live makes billed native /decisions calls only; no Responses/Chat Completions fallback or Discord sends.\n"); return;
  }
  const format = values.format ?? "json"; const choices = values.choices ?? "detailed"; const questions = values.questions ?? "together";
  if (format !== "json" && format !== "dialogue" || choices !== "detailed" && choices !== "short" || questions !== "together" && questions !== "separate") throw new Error("Invalid variant");
  const variant: LayaReplayVariant = { format, choices, questions };
  const limit = Number(values.limit ?? 216); const timeoutMs = Number(values["timeout-ms"] ?? 60000);
  if (!Number.isInteger(limit) || limit < 1 || limit > 216 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("Invalid limits");
  const fixtures = contextualReplayCases();
  if (values.language && !fixtures.some((fixture) => fixture.language === values.language) || values.scenario && !fixtures.some((fixture) => fixture.scenario === values.scenario)) throw new Error("Invalid filter");
  const cases = fixtures.filter((fixture) => (!values.language || fixture.language === values.language) && (!values.scenario || fixture.scenario === values.scenario)).slice(0, limit);
  if (values.live && !values.instance) throw new Error("Live comparison requires --instance");
  const environment = values.live ? loadInstanceEnvironment(values.instance!).environment : null;
  const apiKey = environment?.DECISION_API_KEY ?? environment?.OPENAI_API_KEY;
  if (values.live && !apiKey) throw new Error("Missing API key");
  const model = environment?.DECISION_MODEL ?? "gpt-6-luna";
  const client = values.live ? new OpenAiDecisionsClient({ model, apiKey: apiKey!,
    baseUrl: environment?.DECISION_BASE_URL ?? environment?.OPENAI_BASE_URL ?? "https://api.openai.com/v1" }) : null;
  const results: Result[] = [];
  for (const fixture of cases) {
    const row: Result = { id: fixture.id, language: fixture.language, scenario: fixture.scenario, status: "not_run", durationMs: 0, usage: [], apiCalls: 0 };
    if (client) {
      const started = performance.now();
      try {
        const { port } = await syntheticReplayContext(fixture);
        const lease = await GuardedConversationContext.open(port, { count: 40, budget: 12000, burstIds: [fixture.current.messageId] });
        const request = layaReplayRequest({ ...fixture, current: lease.current, events: lease.history.filter((event) => event.messageId !== lease.current.messageId) }, variant);
        const typedQuestions: TypedDecisionQuestion[] = layaQuestionKeys.map((name) => ({ type: "choice", name,
          instructions: request.questions[name].instructions,
          choices: Object.entries(request.questions[name].criteria).map(([value, description]) => ({ value, description })) }));
        const answers: Record<string, TypedDecisionAnswer> = {};
        const signal = AbortSignal.timeout(timeoutMs);
        for (const group of variant.questions === "separate" ? typedQuestions.map((question) => [question]) : [typedQuestions]) {
          row.apiCalls++;
          const response = await client.decide(request.state, group, { signal, onUsage: (usage) => row.usage.push(usage),
            beforeAttempt: async (): Promise<void> => { if (!await lease.validate()) throw new Error("Synthetic context invalidated"); } });
          Object.assign(answers, response.answers);
        }
        row.classification = layaClassificationSchema.parse(Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key, answer.value])));
        row.confidence = Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key, answer.confidence]));
        Object.assign(row, assessLayaClassification(fixture, row.classification)); row.status = "valid";
      } catch (error) { row.status = "failed"; row.failure = safeFailure(error); }
      row.durationMs = Math.round(performance.now() - started);
    }
    results.push(row);
  }
  const usage = results.flatMap((row) => row.usage);
  const summary = { mode: client ? "native_openai_decision_classification" : "fixture_inventory_only", fixtureRevision: 3, layaReplayRevision,
    endpoint: "/v1/decisions", model, variant, reasoningEffort: null, timeoutMs, concurrency: 1,
    ...client ? metrics(results) : { cases: cases.length },
    byLanguage: client ? Object.fromEntries([...new Set(results.map((row) => row.language))].map((language) => [language, metrics(results.filter((row) => row.language === language))])) : null,
    byScenario: client ? Object.fromEntries([...new Set(results.map((row) => row.scenario))].map((scenario) => [scenario, metrics(results.filter((row) => row.scenario === scenario))])) : null,
    tokenUsage: { input: usage.reduce((sum, item) => sum + item.inputTokens, 0), output: usage.reduce((sum, item) => sum + item.outputTokens, 0),
      cached: usage.reduce((sum, item) => sum + (item.cachedInputTokens ?? 0), 0), reasoning: usage.reduce((sum, item) => sum + (item.reasoningTokens ?? 0), 0),
      measuredCalls: usage.length, attemptedCalls: results.reduce((sum, row) => sum + row.apiCalls, 0) },
    scope: "Exact same synthetic evidence serialization, question instructions, choice labels/descriptions and expected relationship/text labels as the selected Laya variant; native API wire format differs. No production policy, generation or delivery. Confidence is not calibrated; synthetic results are not deployment acceptance.",
    discordSends: 0 };
  const output = resolve(values.output ?? "data/evaluations/openai-decisions-classification.json");
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ summary, results }, null, 2), "utf8");
  process.stdout.write(JSON.stringify({ ...summary, output }) + "\n");
  if (client && results.some((row) => row.status !== "valid")) process.exitCode = 2;
}
void main().catch((error: unknown) => { process.stderr.write(JSON.stringify({ status: "failed", ...safeFailure(error, "operation_error") }) + "\n"); process.exitCode = 1; });
