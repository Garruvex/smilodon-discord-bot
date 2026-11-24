import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import pino from "pino";

import {
  continuityBlindSheet, continuityFreezeHash, continuityMetrics, continuityVariants, continuityVariantSettings, continuityVerdicts,
  type ContinuityRow, type ContinuityVariant,
} from "../application/chat/continuity-evaluation.js";
import { createChatProviderFromConfig } from "../bootstrap/dependencies.js";
import { loadConfiguration } from "../config/environment.js";
import { loadInstanceEnvironment } from "../config/instance-environment.js";
import { continuityBaselinePath, loadFrozenCases, offlineBaselineOf, offlinePersona, runContinuityCase, scriptedReply } from "./replay-continuity-runner.js";

const usage = `Usage: npm run eval:continuity -- [--live --instance <name> --persona <personality.md>] [--variants current,direct,anchor] [--repeat 1] [--cases id,id] [--output dir]
       npm run eval:continuity -- --check-baseline | --write-baseline
Offline (default) uses a scripted reply and records only what reached the model's context. --live sends each case's
final turn to the instance's configured chat and utility models (billed). Nothing is posted to Discord.
`;
async function main(): Promise<void> {
  const { values } = parseArgs({ allowPositionals: false, options: { live: { type: "boolean" }, instance: { type: "string" }, persona: { type: "string" },
    variants: { type: "string" }, repeat: { type: "string" }, cases: { type: "string" }, output: { type: "string" }, help: { type: "boolean" },
    "check-baseline": { type: "boolean" }, "write-baseline": { type: "boolean" } } });
  if (values.help) { process.stdout.write(usage); return; }
  const file = await loadFrozenCases();
  const variants = (values.variants?.split(",") ?? [...continuityVariants]) as ContinuityVariant[];
  if (variants.some((variant) => !continuityVariants.includes(variant))) throw new Error(`--variants must be from ${continuityVariants.join(", ")}`);
  const repeat = Number(values.repeat ?? 1); if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error("--repeat must be 1-5");
  const selected = values.cases ? file.cases.filter((item) => values.cases!.split(",").includes(item.id)) : file.cases;
  const logger = pino({ level: process.env.LOG_LEVEL || "warn" });
  let providers = { reply: scriptedReply, utility: scriptedReply }; let personality = offlinePersona; let models: Record<string, string | null> = { reply: "scripted", utility: "scripted" };
  if (values.live) {
    if (!values.instance || !values.persona) throw new Error("--live needs --instance and --persona");
    const configuration = loadConfiguration(loadInstanceEnvironment(values.instance).environment);
    if (!configuration.chat) throw new Error("The instance has no chat model configured");
    const reply = createChatProviderFromConfig(configuration.chat, logger);
    providers = { reply, utility: configuration.utilityChat ? createChatProviderFromConfig(configuration.utilityChat, logger) : reply };
    personality = await readFile(resolve(values.persona), "utf8");
    models = { reply: configuration.chat.models[0] ?? null, utility: configuration.utilityChat?.models[0] ?? configuration.chat.models[0] ?? null };
  }
  const rows: ContinuityRow[] = [];
  // Case-major order, so drift in provider latency over the run falls on every variant alike.
  for (let round = 1; round <= repeat; round++) for (const item of selected) for (const variant of variants) {
    const row = await runContinuityCase({ file, item, variant, repeat: round, providers, personality, logger });
    const { request: _request, coverage: _coverage, ...kept } = row; rows.push(kept);
    process.stdout.write(`${item.id} ${variant} r${round}: ${row.action}${row.contextHasRequired === null ? "" : row.contextHasRequired ? " ctx+" : " ctx-"}${row.anchorAdded ? ` anchor${row.anchorAdded}` : ""} ${Math.round(row.latencyMs)}ms${row.failure ? ` FAILED ${row.failure}` : ""}\n`);
  }
  if (values["write-baseline"] || values["check-baseline"]) {
    if (values.live || selected.length !== file.cases.length || variants.length !== continuityVariants.length || repeat !== 1) throw new Error("Baselines cover the full offline run");
    const baseline = offlineBaselineOf(rows);
    if (values["write-baseline"]) { await writeFile(continuityBaselinePath, `${JSON.stringify({ sha256: continuityFreezeHash(file), rows: baseline }, null, 2)}\n`, "utf8"); process.stdout.write(`Wrote ${continuityBaselinePath}\n`); return; }
    const frozen = JSON.parse(await readFile(continuityBaselinePath, "utf8")) as { rows: Record<string, unknown> };
    const changed = Object.keys(baseline).filter((key) => JSON.stringify(baseline[key]) !== JSON.stringify(frozen.rows[key]));
    process.stdout.write(changed.length ? `Offline baseline differs for: ${changed.join(", ")}\n` : "Offline baseline matches.\n");
    if (changed.length) process.exitCode = 1; return;
  }
  const cases = new Map(file.cases.map((item) => [item.id, item]));
  const by = <K extends keyof ContinuityRow>(key: K): Record<string, Record<string, ReturnType<typeof continuityMetrics>>> => Object.fromEntries([...new Set(rows.map((row) => String(row[key])))]
    .map((value) => [value, Object.fromEntries(variants.map((variant) => [variant, continuityMetrics(rows.filter((row) => row.variant === variant && String(row[key]) === value), cases)]))]));
  const summary = {
    live: values.live === true, models, casesVersion: file.version, sha256: continuityFreezeHash(file), cases: selected.length, repeat, variants: Object.fromEntries(variants.map((variant) => [variant, continuityVariantSettings[variant]])),
    thresholds: file.thresholds,
    overall: Object.fromEntries(variants.map((variant) => [variant, continuityMetrics(rows.filter((row) => row.variant === variant), cases)])),
    followUp: Object.fromEntries(variants.map((variant) => [variant, continuityMetrics(rows.filter((row) => row.variant === variant && file.thresholds.anchor.followUpScenarios.includes(row.scenario)), cases)])),
    byScenario: by("scenario"), byLanguage: by("language"),
    verdicts: variants.length === continuityVariants.length ? continuityVerdicts(file, rows) : null,
    humanReview: "Labels are developer-authored and provisional; the blind sheet needs a person's paired judgments before the result counts as acceptance.",
  };
  const output = resolve(values.output ?? join("data", "evaluations", `continuity-${values.live ? "live" : "offline"}-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`));
  await mkdir(output, { recursive: true });
  const blind = continuityBlindSheet(file, rows);
  await writeFile(join(output, "rows.json"), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await writeFile(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(join(output, "blind-sheet.json"), `${JSON.stringify(blind.sheet, null, 2)}\n`, "utf8");
  await writeFile(join(output, "blind-key.json"), `${JSON.stringify(blind.key, null, 2)}\n`, "utf8");
  process.stdout.write(`\n${JSON.stringify({ overall: summary.overall, followUp: summary.followUp, verdicts: summary.verdicts }, null, 2)}\nResults: ${output}\n`);
}

await main();
