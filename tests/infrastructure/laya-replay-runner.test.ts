import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { contextualReplayCases } from "../../src/application/chat/contextual-replay.js";
import { layaChoiceOptions, layaQuestionKeys } from "../../src/application/chat/laya-contextual-replay.js";

const execute = promisify(execFile);
const reportSchema = z.object({ summary: z.object({ cases: z.number(), valid: z.number().optional(), failed: z.number().optional(),
  truncated: z.number().optional(), relationshipAccuracyAllCases: z.number().nullable().optional(),
  finalHealthFailure: z.unknown(), checkpointStable: z.boolean(), discordSends: z.literal(0),
  comparison: z.object({ validUntruncatedPairs: z.number() }).nullable() }),
  results: z.array(z.object({ status: z.string(), prediction: z.unknown().optional(),
    failure: z.object({ failure: z.string(), httpStatus: z.number().optional(), reason: z.string().optional() }).optional() })) });

async function replay(options: { live?: boolean; failure?: boolean; truncated?: boolean; finalHealthFailure?: boolean; baseline?: boolean; separate?: boolean } = {}): Promise<{
  code: number; report: z.infer<typeof reportSchema>; requests: number; json: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "laya-replay-"));
  const output = join(directory, "report.json");
  const prediction = {
    answers: Object.fromEntries(layaQuestionKeys.map((key) => {
      const criteria = Object.keys(layaChoiceOptions[key]);
      return [key, { type: "choice", choice: criteria[0], answer_confidence: 1,
        probabilities: Object.fromEntries(criteria.map((label, index) => [label, index === 0 ? 1 : 0])) }];
    })),
    usage: { input_tokens: 300, output_tokens: 0, state_tokens: 80, state_tokens_dropped: options.truncated ? 1 : 0,
      truncated: options.truncated ?? false, truncated_questions: options.truncated ? ["relationship"] : [] },
    routing: { model: "multilingual", repo: "synthetic-checkpoint" },
  };
  // Preload a deterministic transport in the subprocess. No sockets or model
  // weights: still exercise argument parsing, context leases and report writing.
  const preload = join(directory, "transport.mjs");
  const counterPath = join(directory, "requests.json");
  await writeFile(preload, `import { writeFileSync } from 'node:fs';
    const options = ${JSON.stringify(options)};
    const counterPath = ${JSON.stringify(counterPath)};
    let requests = 0, predictions = 0, healthChecks = 0;
    writeFileSync(counterPath, '0');
    globalThis.fetch = async (url, request) => {
      requests++; writeFileSync(counterPath, JSON.stringify(requests));
      if (new URL(url).pathname === '/health') {
        healthChecks++;
        if (options.finalHealthFailure && healthChecks === 2) return new Response('secret-sentinel', {status:503});
        return Response.json({status:'ok',loaded:['multilingual'],revisions:{multilingual:'synthetic-revision'},checkpoint_devices:{multilingual:'cuda:0'}});
      }
      predictions++;
      if (options.failure && predictions === 2) return new Response('secret-sentinel', {status:503});
      const full = ${JSON.stringify(prediction)};
      const keys = Object.keys(JSON.parse(request.body).questions);
      return Response.json({...full, answers:Object.fromEntries(keys.map(key => [key,full.answers[key]]))});
    };`);
  const args = ["--import", pathToFileURL(preload).href, "--import", "tsx", resolve("src/scripts/replay-laya-decisions.ts"), "--limit", "3", "--output", output,
    "--url", "http://synthetic.invalid:8000"];
  if (options.live) args.push("--live", "--require-cuda");
  if (options.separate) args.push("--format", "dialogue", "--choices", "short", "--questions", "separate");
  if (options.baseline) {
    const baseline = join(directory, "baseline.json");
    await writeFile(baseline, JSON.stringify({ summary: { fixtureRevision: 3, mode: "live_synthetic_decision_replay" },
      results: contextualReplayCases().slice(0, 3).map((fixture) => ({ id: fixture.id, language: fixture.language, scenario: fixture.scenario,
        status: "valid", durationMs: 20, relationship: "followup", intent: "answer", action: "reply", referent: "self_contained" })) }));
    args.push("--baseline", baseline);
  }
  let code = 0;
  try {
    await execute(process.execPath, args, { timeout: 15000, env: { ...process.env, LAYA_API_KEY: "secret-sentinel" } });
  } catch (error) {
    const parsed = z.object({ code: z.number() }).safeParse(error);
    if (!parsed.success) throw error;
    code = parsed.data.code;
    if (code !== 2) throw error;
  }
  const json = await readFile(output, "utf8");
  const requests = z.number().parse(JSON.parse(await readFile(counterPath, "utf8")) as unknown);
  return { code, report: reportSchema.parse(JSON.parse(json) as unknown), requests, json };
}

describe("Laya evaluation CLI with mock transport (no sockets or real weights)", () => {
  it("keeps inventory offline even when an endpoint is supplied", async () => {
    const result = await replay();
    expect(result.code).toBe(0); expect(result.requests).toBe(0);
    expect(result.report.results.map((row) => row.status)).toEqual(["not_run", "not_run", "not_run"]);
  });
  it("writes a paired report without generating contributions or leaking the key", async () => {
    const result = await replay({ live: true, baseline: true });
    expect(result.code).toBe(0);
    expect(result.report.summary).toMatchObject({ cases: 3, valid: 3, failed: 0, checkpointStable: true, relationshipAccuracyAllCases: 1,
      comparison: { validUntruncatedPairs: 3 }, discordSends: 0 });
    expect(result.json).not.toContain("secret-sentinel"); expect(JSON.stringify(result.report.results)).not.toContain("contribution");
  });
  it("keeps transport failures in the accuracy denominator and returns incomplete", async () => {
    const result = await replay({ live: true, failure: true });
    expect(result.code).toBe(2);
    expect(result.report.summary).toMatchObject({ valid: 2, failed: 1, relationshipAccuracyAllCases: 2 / 3 });
    expect(result.report.results.find((row) => row.status === "failed")?.prediction).toBeUndefined();
    expect(result.report.results.find((row) => row.status === "failed")?.failure).toEqual({ failure: "http_error", httpStatus: 503, reason: "http_error" });
    expect(result.json).not.toContain("secret-sentinel");
  });
  it("runs dialogue/short/individual mode as twelve predictions for three cases", async () => {
    const result = await replay({ live: true, separate: true });
    expect(result.code).toBe(0); expect(result.requests).toBe(14);
    expect(result.report.summary).toMatchObject({ cases: 3, valid: 3, failed: 0 });
    expect(JSON.parse(result.json) as unknown).toMatchObject({ summary: {
      variant: { format: "dialogue", choices: "short", questions: "separate" }, completedCaseApiCalls: 12,
    } });
  });
  it("excludes truncated cases from paired evidence and returns incomplete", async () => {
    const result = await replay({ live: true, truncated: true, baseline: true });
    expect(result.code).toBe(2);
    expect(result.report.summary).toMatchObject({ truncated: 3, comparison: { validUntruncatedPairs: 0 } });
  });
  it("preserves measured results when the final checkpoint health check fails", async () => {
    const result = await replay({ live: true, finalHealthFailure: true });
    expect(result.code).toBe(2);
    expect(result.report.summary).toMatchObject({ valid: 3, checkpointStable: false });
    expect(result.report.summary.finalHealthFailure).not.toBeNull();
    expect(result.json).not.toContain("secret-sentinel");
  });
});
