import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { contextualReplayCases } from "../application/chat/contextual-replay.js";
import { replyBenchmarkCase, replyBenchmarkMetrics, replyQuestion, contextualReplyQuestion, type ReplyBenchmarkRow } from "../application/chat/reply-benchmark.js";
import { loadInstanceEnvironment, loadSharedEnvironment } from "../config/instance-environment.js";
import { OpenAiDecisionsClient } from "../infrastructure/chat/openai-decisions-client.js";
import { LayaReplayClient } from "../infrastructure/chat/laya-replay-client.js";
import { safeFailure } from "../application/diagnostics/chat-diagnostics.js";

class BenchmarkArgumentError extends Error {}
let stage = "arguments";
function argumentsForBenchmark(): ReturnType<typeof parseBenchmarkArguments> {
  try { return parseBenchmarkArguments(); }
  catch { throw new BenchmarkArgumentError("Invalid benchmark arguments. Run directly: node node_modules/tsx/dist/cli.mjs src/scripts/replay-reply-benchmark.ts --live --provider both --instance pinecone --require-cuda"); }
}
const benchmarkArguments = { allowPositionals: false, options: { live: { type: "boolean" }, help: { type: "boolean" },
    provider: { type: "string" }, instance: { type: "string" }, url: { type: "string" }, policy: { type: "string" },
    limit: { type: "string" }, output: { type: "string" }, "require-cuda": { type: "boolean" } } } as const;
function parseBenchmarkArguments(): ReturnType<typeof parseArgs<typeof benchmarkArguments>> {
  return parseArgs(benchmarkArguments);
}
async function main(): Promise<void> {
  const { values } = argumentsForBenchmark();
  if (values.help) {
    process.stdout.write("Usage: npm run eval:reply -- [--live --provider both|openai|laya --instance pinecone] [--policy baseline|contextual] [--url http://127.0.0.1:8000] [--require-cuda] [--limit 216] [--output report.json]\nDefault is offline inventory. Live OpenAI calls are billed. One yes/no question; no policy, generation or Discord sends.\n"); return;
  }
  const provider = values.provider ?? "both";
  const policy = values.policy ?? "baseline";
  if (policy !== "baseline" && policy !== "contextual") throw new BenchmarkArgumentError("--policy must be baseline or contextual");
  const question = policy === "contextual" ? contextualReplyQuestion : replyQuestion;
  if (!["both", "openai", "laya"].includes(provider)) throw new Error("Invalid provider");
  const limit = Number(values.limit ?? 216);
  if (!Number.isInteger(limit) || limit < 1 || limit > 216) throw new Error("Invalid limit");
  const providers = provider === "both" ? ["openai", "laya"] : [provider];
  if (values.live && providers.includes("openai") && !values.instance) throw new Error("OpenAI requires --instance");
  if (values["require-cuda"] && (!values.live || !providers.includes("laya"))) throw new Error("CUDA check requires live Laya");
  stage = "load_configuration";
  const env = values.live && providers.includes("openai") ? loadInstanceEnvironment(values.instance!).environment : null;
  const localEnv = env ?? loadSharedEnvironment();
  const key = env?.DECISION_API_KEY || env?.OPENAI_API_KEY;
  if (env && !key) throw new Error("Missing OpenAI key");
  stage = "openai_configuration";
  const openai = env ? new OpenAiDecisionsClient({ baseUrl: env.DECISION_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: key!, model: "gpt-6-luna" }) : null;
  stage = "laya_configuration";
  const laya = values.live && providers.includes("laya") ? new LayaReplayClient({ baseUrl: values.url ?? localEnv.LAYA_BASE_URL ?? `http://127.0.0.1:${localEnv.LAYA_PORT || "8000"}`,
    ...(localEnv.LAYA_API_KEY ? { apiKey: localEnv.LAYA_API_KEY } : {}), timeoutMs: 60000, model: "multilingual", maxLen: 8192, headMaxLen: 512 }) : null;
  stage = "laya_health";
  const health = laya ? await laya.health() : null;
  stage = "laya_checkpoint";
  if (health && (!health.loaded.includes("multilingual") || !health.revisions.multilingual)) throw new Error("Laya checkpoint not loaded");
  if (values["require-cuda"] && !health?.checkpoint_devices.multilingual?.startsWith("cuda")) throw new Error("Laya CUDA not verified");
  const results: (ReplyBenchmarkRow & { id: string; provider: string; language: string; scenario: string; input: string; labelReason: string;
    confidence?: number; usage?: unknown; failure?: ReturnType<typeof safeFailure> })[] = [];
  stage = "benchmark";
  for (const fixture of contextualReplayCases().slice(0, limit)) {
    const sample = replyBenchmarkCase(fixture);
    for (const name of providers) {
      const row: typeof results[number] = { id: fixture.id, provider: name, language: fixture.language, scenario: fixture.scenario,
        input: sample.state, expected: sample.expected, labelReason: sample.labelReason,
        prediction: null, status: sample.expected === null ? "review_required" : "not_run", durationMs: 0 };
      if (values.live && sample.expected !== null) {
        const started = performance.now();
        try {
          if (name === "openai") {
            const response = await openai!.decide(sample.state, [{ type: "choice", name: "reply", instructions: question.instructions,
              choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })) }],
            { signal: AbortSignal.timeout(60000), onUsage: (usage) => { row.usage = usage; } });
            const answer = response.answers.reply!;
            if (answer.value !== "yes" && answer.value !== "no") throw new Error("Invalid binary answer");
            row.prediction = answer.value; row.confidence = answer.confidence;
          } else {
            const response = await laya!.predictReply(sample.state, question);
            row.prediction = response.choice; row.confidence = response.confidence; row.usage = response.usage;
          }
          row.status = "valid";
        } catch (error) { row.status = "failed"; row.failure = safeFailure(error); }
        row.durationMs = Math.round(performance.now() - started);
      }
      results.push(row);
    }
  }
  stage = "laya_final_health";
  const finalHealth = laya ? await laya.health() : null;
  const checkpointStable = health && finalHealth ? health.revisions.multilingual === finalHealth.revisions.multilingual &&
    health.checkpoint_devices.multilingual === finalHealth.checkpoint_devices.multilingual : null;
  const summary = { benchmark: "binary_should_reply", revision: 2, policy, mode: values.live ? "live" : "inventory", question,
    models: { openai: "gpt-6-luna", laya: "multilingual" }, health, finalHealth, checkpointStable,
    labelProvenance: "Provisional synthetic fixture expectations; not independently human-reviewed ground truth. Group/thanks excluded pending adjudication.",
    scope: "Identical input/instructions/yes-no choices. No confidence threshold, application policy, reply generation or Discord sends. Failures are separate from No predictions; accuracy counts failures as incorrect. Precision/recall and latency use valid calls only.",
    monetaryCost: "Not estimated; per-call usage included. Laya token counts are local compute diagnostics, not API charges.",
    byProvider: Object.fromEntries(providers.map((name) => [name, values.live ? replyBenchmarkMetrics(results.filter((row) => row.provider === name)) : null])),
    byScenario: values.live ? Object.fromEntries(providers.map((name) => [name, Object.fromEntries(
      [...new Set(results.map((row) => row.scenario))].map((scenario) => [scenario,
        replyBenchmarkMetrics(results.filter((row) => row.provider === name && row.scenario === scenario))]))])) : null,
    discordSends: 0 };
  const output = resolve(values.output ?? `data/evaluations/reply-benchmark-${Date.now()}.json`);
  stage = "write_report";
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ summary, results }, null, 2));
  process.stdout.write(JSON.stringify({ ...summary, output }) + "\n");
  if (results.some((row) => row.status === "failed") || checkpointStable === false) process.exitCode = 2;
}
void main().catch((error: unknown) => {
  const hints: Record<string, string> = {
    laya_health: "Laya health check failed before model calls. Start Docker Desktop and the laya service; verify /health and the configured LAYA_PORT or --url.",
    laya_checkpoint: "Laya must preload multilingual and report CUDA when --require-cuda is used.",
    load_configuration: "Check the instance environment file and shared configuration.",
    openai_configuration: "Check the instance OpenAI key and base URL.",
    laya_configuration: "Check the Laya URL and port configuration.",
  };
  process.stderr.write(JSON.stringify(error instanceof BenchmarkArgumentError ? { failure: "invalid_arguments", message: error.message } :
    { ...safeFailure(error), stage, ...(hints[stage] ? { hint: hints[stage] } : {}) }) + "\n");
  process.exitCode = 1;
});
