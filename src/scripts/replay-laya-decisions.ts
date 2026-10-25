import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { contextualReplayCases } from "../application/chat/contextual-replay.js";
import { assessLayaClassification, layaQuestionKeys, layaReplayRequest, layaReplayRevision, parseLayaBaseline,
  type LayaBaselineRow, type LayaReplayVariant } from "../application/chat/laya-contextual-replay.js";
import { syntheticReplayContext } from "../application/chat/synthetic-replay-context.js";
import { GuardedConversationContext } from "../application/chat/guarded-conversation-context.js";
import { safeFailure } from "../application/diagnostics/chat-diagnostics.js";
import { LayaReplayClient, LayaReplayError, type LayaReplayPrediction } from "../infrastructure/chat/laya-replay-client.js";

interface ReplayResult {
  id: string; language: string; scenario: string; status: "not_run" | "valid" | "failed"; durationMs: number;
  prediction?: LayaReplayPrediction; relationshipCorrect?: boolean; disallowedReply?: boolean;
  failure?: ReturnType<typeof replayFailure>;
  baseline?: LayaBaselineRow;
}
class ReplaySetupError extends Error {}
function replayFailure(error: unknown): ReturnType<typeof safeFailure> & { reason?: string } {
  return { ...safeFailure(error), ...(error instanceof LayaReplayError ? { reason: error.reason } : {}) };
}
function integer(value: string | undefined, defaultValue: number, minimum: number, maximum: number): number {
  const number = Number(value ?? defaultValue);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new ReplaySetupError("Invalid numeric replay option");
  return number;
}
function metrics(rows: readonly ReplayResult[]): Record<string, number | null> {
  const valid = rows.filter((row) => row.status === "valid");
  const times = valid.map((row) => row.durationMs).sort((a, b) => a - b);
  return { cases: rows.length, valid: valid.length, failed: rows.filter((row) => row.status === "failed").length,
    correctRelationships: valid.filter((row) => row.relationshipCorrect).length,
    relationshipAccuracyAllCases: rows.length ? valid.filter((row) => row.relationshipCorrect).length / rows.length : null,
    replyProposalsOnDisallowedCases: valid.filter((row) => row.disallowedReply).length,
    replyProposals: valid.filter((row) => row.prediction?.classification.action === "reply").length,
    truncated: valid.filter((row) => row.prediction?.usage.truncated).length,
    highConfidenceRelationshipErrors: valid.filter((row) => !row.relationshipCorrect && (row.prediction?.answerConfidence.relationship ?? 0) >= 0.9).length,
    p50Ms: times.length ? times[Math.floor(times.length * 0.5)]! : null,
    p95Ms: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]! : null };
}
async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    help: { type: "boolean" }, live: { type: "boolean" }, "require-cuda": { type: "boolean" },
    url: { type: "string" }, model: { type: "string" }, baseline: { type: "string" }, output: { type: "string" },
    language: { type: "string" }, scenario: { type: "string" }, limit: { type: "string" }, concurrency: { type: "string" },
    "max-len": { type: "string" }, "head-max-len": { type: "string" }, "timeout-ms": { type: "string" },
    format: { type: "string" }, choices: { type: "string" }, questions: { type: "string" },
  } });
  if (values.help) {
    process.stdout.write("Usage: npm run eval:laya -- [--live --url http://127.0.0.1:8000 --require-cuda] [--baseline cloud-report.json] [--format json|dialogue] [--choices detailed|short] [--questions together|separate] [--language zh-TW|en|ja] [--scenario answer] [--limit 216] [--concurrency 1] [--model multilingual|english|typed-decisions] [--max-len 8192] [--head-max-len 512] [--timeout-ms 60000] [--output data/evaluations/laya-contextual.json]\nDefault: synthetic fixture inventory only; no model calls. API key: LAYA_API_KEY environment variable. Classification comparison only; no production policy, text generation or Discord delivery.\n");
    return;
  }
  const limit = integer(values.limit, 216, 1, 216);
  const concurrency = integer(values.concurrency, 1, 1, 4);
  const timeoutMs = integer(values["timeout-ms"], 60000, 1000, 120000);
  const format = values.format ?? "json"; const choices = values.choices ?? "detailed"; const questions = values.questions ?? "together";
  if (format !== "json" && format !== "dialogue" || choices !== "detailed" && choices !== "short"
    || questions !== "together" && questions !== "separate") throw new ReplaySetupError("Unknown replay variant");
  const variant: LayaReplayVariant = { format, choices, questions };
  const model = values.model ?? "multilingual";
  if (model !== "multilingual" && model !== "english" && model !== "typed-decisions") throw new ReplaySetupError("Unknown Laya checkpoint");
  const maxLen = integer(values["max-len"], model === "multilingual" ? 8192 : model === "english" ? 512 : 1024, 128, model === "multilingual" ? 8192 : model === "english" ? 512 : 1024);
  const headMaxLen = integer(values["head-max-len"], Math.min(512, Math.floor(maxLen / 2)), 64, maxLen - 1);
  const fixtures = contextualReplayCases();
  if (values.language && !fixtures.some((fixture) => fixture.language === values.language)
    || values.scenario && !fixtures.some((fixture) => fixture.scenario === values.scenario)) throw new ReplaySetupError("Unknown replay filter");
  const cases = fixtures.filter((fixture) => (!values.language || fixture.language === values.language)
    && (!values.scenario || fixture.scenario === values.scenario)).slice(0, limit);
  const baseline = values.baseline ? parseLayaBaseline(JSON.parse(await readFile(resolve(values.baseline), "utf8")) as unknown, fixtures) : null;
  const output = resolve(values.output ?? "data/evaluations/laya-contextual.json");
  if (values.baseline && output.toLowerCase() === resolve(values.baseline).toLowerCase()) throw new ReplaySetupError("Output must not replace baseline");
  const client = values.live ? new LayaReplayClient({ baseUrl: values.url ?? process.env.LAYA_BASE_URL ?? "http://127.0.0.1:8000",
    ...(process.env.LAYA_API_KEY ? { apiKey: process.env.LAYA_API_KEY } : {}), model, maxLen, headMaxLen, timeoutMs }) : null;
  const health = client ? await client.health() : null;
  if (health && (!health.loaded.includes(model) || !health.revisions[model])) throw new ReplaySetupError("Requested checkpoint must be preloaded with a reported revision");
  if (values["require-cuda"] && !client) throw new ReplaySetupError("CUDA verification requires --live");
  if (values["require-cuda"] && !health?.checkpoint_devices[model]?.startsWith("cuda")) throw new ReplaySetupError("Requested checkpoint is not running on CUDA");
  const results: ReplayResult[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: client ? concurrency : 1 }, async () => {
    while (cursor < cases.length) {
      const fixture = cases[cursor++]!;
      const row: ReplayResult = { id: fixture.id, language: fixture.language, scenario: fixture.scenario, status: "not_run", durationMs: 0 };
      const reference = baseline?.get(fixture.id);
      if (reference) row.baseline = reference;
      if (client) {
        const started = performance.now();
        try {
          const { port } = await syntheticReplayContext(fixture);
          const lease = await GuardedConversationContext.open(port, { count: 40, budget: 12000, burstIds: [fixture.current.messageId] });
          if (!await lease.validate()) throw new Error("Synthetic context invalidated");
          row.prediction = await client.predict(layaReplayRequest({ ...fixture, current: lease.current,
            events: lease.history.filter((event) => event.messageId !== lease.current.messageId) }, variant), variant.questions);
          if (!await lease.validate()) throw new Error("Synthetic context invalidated");
          Object.assign(row, assessLayaClassification(fixture, row.prediction.classification));
          row.status = "valid";
        } catch (error) { delete row.prediction; row.status = "failed"; row.failure = replayFailure(error); }
        row.durationMs = Math.round(performance.now() - started);
      }
      results.push(row);
    }
  }));
  const paired = results.filter((row) => row.status === "valid" && !row.prediction?.usage.truncated
    && row.baseline?.status === "valid" && layaQuestionKeys.every((key) => row.baseline?.[key] !== null));
  let finalHealth: typeof health = null;
  let finalHealthFailure: ReturnType<typeof safeFailure> | null = null;
  if (client) {
    try { finalHealth = await client.health(); } catch (error) { finalHealthFailure = safeFailure(error); }
  }
  const gpuVerified = !!health?.checkpoint_devices[model]?.startsWith("cuda") && !!finalHealth?.checkpoint_devices[model]?.startsWith("cuda");
  const checkpointStable = !!health?.revisions[model] && health.revisions[model] === finalHealth?.revisions[model];
  const summary = {
    mode: client ? "live_synthetic_laya_classification" : "fixture_inventory_only", fixtureRevision: 3, layaReplayRevision,
    model, variant, maxLen, headMaxLen, concurrency, timeoutMs, health, finalHealth, finalHealthFailure, gpuVerified, checkpointStable,
    ...client ? metrics(results) : { cases: cases.length },
    failures: Object.fromEntries([...new Set(results.flatMap((row) => row.failure ? [JSON.stringify(row.failure)] : []))]
      .map((failure) => [failure, results.filter((row) => row.failure && JSON.stringify(row.failure) === failure).length])),
    byLanguage: client ? Object.fromEntries([...new Set(results.map((row) => row.language))].map((language) => [language, metrics(results.filter((row) => row.language === language))])) : null,
    byScenario: client ? Object.fromEntries([...new Set(results.map((row) => row.scenario))].map((scenario) => [scenario, metrics(results.filter((row) => row.scenario === scenario))])) : null,
    comparison: baseline && client ? { matched: results.filter((row) => row.baseline).length, validUntruncatedPairs: paired.length,
      agreementCounts: Object.fromEntries(layaQuestionKeys.map((key) => [key, paired.filter((row) => row.prediction?.classification[key] === row.baseline?.[key]).length])),
      layaCorrectRelationships: paired.filter((row) => row.relationshipCorrect).length,
      baselineCorrectRelationships: paired.filter((row) => fixtures.find((fixture) => fixture.id === row.id)!.expectedRelationships.includes(row.baseline!.relationship!)).length,
    } : null,
    localInputTokens: client ? results.reduce((sum, row) => sum + (row.prediction?.usage.input_tokens ?? 0), 0) : null,
    completedCaseApiCalls: client ? results.reduce((sum, row) => sum + (row.prediction?.apiCalls ?? 0), 0) : null,
    scope: "Classification projection only. Different prompt/schema from cloud replay; agreement is not accuracy. Only relationship and forbidden text replies have fixture labels. Silent on every case is not success. No production acceptance gate.",
    limitations: "216 synthetic variations, not independent real conversations. No reply target/link/evidence selection, contribution generation, scheduling, D&D evaluation or delivery. Confidence is uncalibrated. First request may include warmup; latency excludes failed requests. Local token counts are compute diagnostics, not API bill savings.",
    discordSends: 0,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ summary, results: results.sort((a, b) => a.id.localeCompare(b.id)) }, null, 2), "utf8");
  process.stdout.write(JSON.stringify({ ...summary, output }) + "\n");
  if (client && (!checkpointStable || results.some((row) => row.status !== "valid" || row.prediction?.usage.truncated)
    || values["require-cuda"] && !gpuVerified)) process.exitCode = 2;
}
void main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify({ status: "failed", ...safeFailure(error, "operation_error"),
    ...(error instanceof ReplaySetupError ? { reason: error.message } : {}) }) + "\n");
  process.exitCode = 1;
});
