import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);
const summarySchema = z.object({ mode: z.string(), endpoint: z.literal("/v1/decisions"), model: z.literal("gpt-6-luna"),
  valid: z.number().optional(), failed: z.number().optional(), reasoningEffort: z.null(), discordSends: z.literal(0),
  tokenUsage: z.object({ input: z.number(), output: z.number(), reasoning: z.number(), attemptedCalls: z.number() }) });
async function run(mode: "inventory" | "together" | "separate" | "refusal"): Promise<{ code: number; summary: z.infer<typeof summarySchema>; report: string }> {
  const directory = await mkdtemp(join(tmpdir(), "native-decisions-replay-"));
  await mkdir(join(directory, "config", "instances"), { recursive: true });
  await writeFile(join(directory, "config", "instances", "replay.env"), "INSTANCE_NAME=replay\nOPENAI_API_KEY=SECRET_SENTINEL\nOPENAI_BASE_URL=https://synthetic.invalid/v1\n");
  const preload = join(directory, "mock.mjs");
  await writeFile(preload, `globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname !== '/v1/decisions') throw new Error('Unexpected endpoint');
    const body=JSON.parse(options.body);
    if ('reasoning' in body || 'response_format' in body || 'messages' in body) throw new Error('Wrong protocol');
    const values={relationship:'followup',intent:'answer',action:'reply',referent:'context_linked'};
    return Response.json({model:'gpt-6-luna',answers:body.questions.map(q => ${JSON.stringify(mode)} === 'refusal' ? {type:'refusal',name:q.name} :
      {type:'choice',name:q.name,choice:values[q.name],confidence:0.99,probabilities:q.choices.map(c=>({value:c.value,probability:c.value===values[q.name]?0.99:0.01/(q.choices.length-1)}))}),
      usage:{input_tokens:100,output_tokens:0,total_tokens:100,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}});
  };`);
  const output = join(directory, "report.json");
  const args = ["--import", pathToFileURL(preload).href, "--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
    resolve("src/scripts/replay-openai-decisions.ts"), "--limit", "3", "--output", output];
  if (mode !== "inventory") args.push("--live", "--instance", "replay");
  if (mode === "separate") args.push("--format", "dialogue", "--choices", "short", "--questions", "separate");
  let code = 0;
  try { await execute(process.execPath, args, { cwd: directory, timeout: 15000 }); }
  catch (error) { const parsed = z.object({ code: z.literal(2) }).safeParse(error); if (!parsed.success) throw error; code = parsed.data.code; }
  const report = await readFile(output, "utf8");
  return { code, report, summary: z.object({ summary: summarySchema }).parse(JSON.parse(report) as unknown).summary };
}
describe("matched native Decisions benchmark CLI with synthetic transport", () => {
  it("does not call a provider in inventory mode", async () => {
    expect((await run("inventory")).summary).toMatchObject({ mode: "fixture_inventory_only", tokenUsage: { attemptedCalls: 0 } });
  });
  it.each(["together", "separate"] as const)("uses native %s questions and preserves actual token usage", async (mode) => {
    const result = await run(mode); expect(result.code).toBe(0);
    const calls = mode === "together" ? 3 : 12;
    expect(result.summary).toMatchObject({ mode: "native_openai_decision_classification", valid: 3, failed: 0,
      reasoningEffort: null, discordSends: 0, tokenUsage: { input: calls * 100, output: 0, reasoning: 0, attemptedCalls: calls } });
    expect(result.report).not.toContain("SECRET_SENTINEL");
  });
  it("reports refusals as failures rather than switching to a generative endpoint", async () => {
    const result = await run("refusal"); expect(result.code).toBe(2); expect(result.summary).toMatchObject({ valid: 0, failed: 3 });
    expect(result.summary.tokenUsage).toMatchObject({ input: 300, attemptedCalls: 3 });
  });
});
