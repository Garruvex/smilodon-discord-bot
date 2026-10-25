import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);
describe("native-only contextual replay selection", () => {
  it.each([false, true])("enforces native transport despite reply configuration; invalid role=%s", async (invalidRole) => {
    const directory = await mkdtemp(join(tmpdir(), "native-contextual-cli-"));
    await mkdir(join(directory, "config", "instances"), { recursive: true });
    const environment = "INSTANCE_NAME=replay\nDISCORD_TOKEN=synthetic\nDISCORD_APPLICATION_ID=123456789012345678\nBOT_OWNER_IDS=345678901234567890\nLAVALINK_PASSWORD=synthetic\nOPENAI_API_KEY=SECRET_SENTINEL\nOPENAI_BASE_URL=https://synthetic.invalid/v1\nCHATBOT_MODEL=gpt-5.6-luna\nCHATBOT_PROVIDER=openai\nCHATBOT_MODE=responses\nCHATBOT_REASONING_EFFORT=medium\n";
    const envFile = join(directory, "config", "instances", "replay.env");
    await writeFile(envFile, environment);
    const countFile = join(directory, "calls.json");
    const preload = join(directory, "mock.mjs");
    const helper = pathToFileURL(resolve("tests/helpers/native-decision-fixtures.ts")).href;
    await writeFile(preload, `import {writeFileSync} from 'node:fs';
      let calls=0; writeFileSync(${JSON.stringify(countFile)},'0');
      globalThis.fetch=async(url,options)=>{
        if(new URL(url).pathname!=='/v1/decisions')throw new Error('Wrong endpoint');
        calls++;writeFileSync(${JSON.stringify(countFile)},JSON.stringify(calls));
        const helper=await import(${JSON.stringify(helper)});
        const body=JSON.parse(options.body);
        return Response.json(helper.nativeDecisionBody(body.questions));
      };`);
    const output = join(directory, "report.json");
    const args = ["--import", pathToFileURL(preload).href, "--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
      resolve("src/scripts/replay-contextual-participation.ts"), "--live", "--native-decisions", "--instance", "replay", "--limit", "1", "--output", output];
    if (invalidRole) args.push("--provider-role", "reply");
    let code = 0;
    try { await execute(process.execPath, args, { cwd: directory, timeout: 15000 }); }
    catch (error) { const parsed = z.object({ code: z.number() }).safeParse(error); if (!parsed.success) throw error; code = parsed.data.code; }
    expect(await readFile(envFile, "utf8")).toBe(environment);
    expect(await readFile(countFile, "utf8")).toBe(invalidRole ? "0" : "1");
    if (invalidRole) { expect(code).toBe(1); return; }
    // One case cannot pass the 200-case acceptance gate, even with valid output.
    expect(code).toBe(2);
    const report: unknown = JSON.parse(await readFile(output, "utf8"));
    expect(report).toMatchObject({ summary: { nativeOnly: true, nativeAdapterRevision: 2, providerSource: "dedicated", valid: 1,
      providerIdentity: { provider: "openai-decisions", models: ["gpt-6-luna"], reasoningEffort: null },
      tokenUsage: { output: 0, reasoning: 0 }, correctRelationships: 1, forbiddenReplyProposals: 0, generatedReplies: 0 },
      results: [{ review: { expectedRelationships: ["followup"], textAllowed: true,
        decision: { contextual: { relationship: "followup", action: "reply" } }, generatedReply: null }, policy: { action: "reply" } }] });
    expect(z.object({ results: z.array(z.object({ review: z.object({ conversation: z.array(z.unknown()) }) })) }).parse(report).results[0]!.review.conversation).toHaveLength(3);
  }, 20000);
});
