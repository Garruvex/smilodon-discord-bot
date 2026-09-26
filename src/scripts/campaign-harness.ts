import "dotenv/config";

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { LlmCampaignNarrator, LlmCampaignPlanner } from "../application/campaign/dm/llm-dm.js";
import { runHarness, type HarnessOptions } from "../application/campaign/harness/campaign-harness.js";
import { defaultHarnessPlayers } from "../application/campaign/harness/harness-personas.js";
import { renderReport, summarizeRun, type TokenPricing } from "../application/campaign/harness/harness-report.js";
import { RuleBasedPlanner, TemplateNarrator } from "../application/campaign/harness/rule-based-dm.js";
import type { StructuredModelClient } from "../application/campaign/ports/structured-model-client.js";
import { SeededRandomSource } from "../application/campaign/random/seeded-random-source.js";
import { RulesetCatalog } from "../application/campaign/rules/ruleset-catalog.js";
import { enSrd51Glossary } from "../application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { CampaignLanguage } from "../domain/campaign/adventure/adventure-bible.js";
import { buildSrd51 } from "../domain/campaign/content/srd-5.1/index.js";
import { milestone0Capabilities } from "../domain/campaign/rules/capabilities.js";
import { GeminiStructuredClient } from "../infrastructure/campaign/llm/gemini-structured-client.js";
import { OpenAiCompatibleStructuredClient } from "../infrastructure/campaign/llm/openai-compatible-structured-client.js";
import { OpenAiResponsesStructuredClient } from "../infrastructure/campaign/llm/openai-responses-structured-client.js";
import { loadStarterAdventure } from "../infrastructure/campaign/starter-adventures.js";
import { InMemoryCampaignStore } from "../infrastructure/persistence/campaign/in-memory-campaign-store.js";

// Plays the starter adventure headlessly and prints a report (plan §12).
//
// Offline, deterministic (the default):
//   npm run campaign:harness -- --language both --rounds 8 --seed 1
// With a real model (keys from OPENAI_API_KEY / OPENAI_BASE_URL / GOOGLE_API_KEY):
//   npm run campaign:harness -- --dm openai-responses --model gpt-5-mini --narrator-model gpt-5-nano \
//     --input-price 0.25 --cached-price 0.025 --output-price 2 --out harness.md
const usage =
  "Usage: campaign-harness [--language en|zh-TW|both] [--rounds N] [--seed N] [--out file.md]\n" +
  "  [--dm offline|openai-responses|openai-compatible|gemini] [--model a,b] [--narrator-model a,b]\n" +
  "  [--reasoning-effort minimal|low|medium|high] [--thinking-budget N]\n" +
  "  [--input-price USD/M] [--cached-price USD/M] [--output-price USD/M]\n";

const { values } = parseArgs({
  options: {
    language: { type: "string", default: "both" },
    rounds: { type: "string", default: "8" },
    seed: { type: "string", default: "1" },
    out: { type: "string" },
    dm: { type: "string", default: "offline" },
    model: { type: "string" },
    "narrator-model": { type: "string" },
    "reasoning-effort": { type: "string" },
    "thinking-budget": { type: "string" },
    "input-price": { type: "string" },
    "cached-price": { type: "string" },
    "output-price": { type: "string" },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n${usage}`);
  process.exit(1);
}

const languages: readonly CampaignLanguage[] =
  values.language === "both" ? ["en", "zh-TW"] : values.language === "en" || values.language === "zh-TW" ? [values.language] : [];
const rounds = Number(values.rounds);
const seed = Number(values.seed);
if (languages.length === 0 || !Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(seed)) fail("Invalid arguments.");

function models(list: string | undefined): readonly string[] {
  return (list ?? "").split(",").map((model) => model.trim()).filter(Boolean);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") fail(`${name} is required for --dm ${values.dm}.`);
  return value;
}

function createClient(modelList: readonly string[]): StructuredModelClient {
  const effort = values["reasoning-effort"];
  if (effort !== undefined && !["minimal", "low", "medium", "high"].includes(effort)) fail("Invalid --reasoning-effort.");
  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  switch (values.dm) {
    case "openai-responses":
      return new OpenAiResponsesStructuredClient({
        baseUrl,
        apiKey: requireEnv("OPENAI_API_KEY"),
        models: modelList,
        ...(effort === undefined ? {} : { reasoningEffort: effort as "minimal" | "low" | "medium" | "high" }),
      });
    case "openai-compatible":
      return new OpenAiCompatibleStructuredClient({ baseUrl, apiKey: requireEnv("OPENAI_API_KEY"), models: modelList });
    case "gemini": {
      const budget = values["thinking-budget"];
      return new GeminiStructuredClient({
        apiKey: requireEnv("GOOGLE_API_KEY"),
        models: modelList,
        ...(budget === undefined ? {} : { thinkingBudget: Number(budget) }),
      });
    }
    default:
      return fail(`Unknown --dm ${values.dm}.`);
  }
}

function createDm(): HarnessOptions["dm"] {
  if (values.dm === "offline") return () => ({ planner: new RuleBasedPlanner(), narrator: new TemplateNarrator() });
  const plannerModels = models(values.model);
  if (plannerModels.length === 0) fail(`--model is required for --dm ${values.dm}.`);
  const narratorModels = models(values["narrator-model"]);
  const plannerClient = createClient(plannerModels);
  const narratorClient = narratorModels.length > 0 ? createClient(narratorModels) : plannerClient;
  return (observe) => ({
    planner: new LlmCampaignPlanner({ client: plannerClient, onCall: observe }),
    narrator: new LlmCampaignNarrator({ client: narratorClient, onCall: observe }),
  });
}

function pricing(): TokenPricing | undefined {
  const input = values["input-price"];
  const output = values["output-price"];
  if (input === undefined || output === undefined) return undefined;
  const parsed = { input: Number(input), cachedInput: Number(values["cached-price"] ?? input), output: Number(output) };
  if (Object.values(parsed).some((price) => !Number.isFinite(price) || price < 0)) fail("Invalid prices.");
  return parsed;
}

const glossaries = { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary } as const;
const content = buildSrd51({ capabilities: milestone0Capabilities, glossaries: [enSrd51Glossary, zhTwSrd51Glossary] });
const adventure = loadStarterAdventure();
const dm = createDm();
const prices = pricing();
const reports: string[] = [];
let problems = 0;

for (const language of languages) {
  const run = await runHarness({
    adventure: adventure[language],
    players: defaultHarnessPlayers,
    dm,
    random: new SeededRandomSource(seed),
    rulesets: new RulesetCatalog([content]),
    rulesetPin: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
    glossary: glossaries[language],
    unitOfWork: new InMemoryCampaignStore(),
    rounds,
  });
  const report = summarizeRun(run, prices);
  problems += report.leaks.length + report.simplifiedCharacters.length;
  reports.push(renderReport(run, report));
}

const output = `${reports.join("\n\n---\n\n")}\n`;
if (values.out === undefined) process.stdout.write(output);
else {
  writeFileSync(values.out, output, "utf8");
  process.stdout.write(`Wrote ${values.out}\n`);
}
if (problems > 0) process.exitCode = 1;
