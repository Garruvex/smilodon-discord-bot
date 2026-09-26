import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { runHarness } from "../application/campaign/harness/campaign-harness.js";
import { defaultHarnessPlayers } from "../application/campaign/harness/harness-personas.js";
import { renderReport, summarizeRun } from "../application/campaign/harness/harness-report.js";
import { RuleBasedPlanner, TemplateNarrator } from "../application/campaign/harness/rule-based-dm.js";
import { SeededRandomSource } from "../application/campaign/random/seeded-random-source.js";
import { RulesetCatalog } from "../application/campaign/rules/ruleset-catalog.js";
import { enSrd51Glossary } from "../application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { CampaignLanguage } from "../domain/campaign/adventure/adventure-bible.js";
import { buildSrd51 } from "../domain/campaign/content/srd-5.1/index.js";
import { milestone0Capabilities } from "../domain/campaign/rules/capabilities.js";
import { loadStarterAdventure } from "../infrastructure/campaign/starter-adventures.js";
import { InMemoryCampaignStore } from "../infrastructure/persistence/campaign/in-memory-campaign-store.js";

// Plays the starter adventure headlessly and prints a report (plan §12).
//   npm run campaign:harness -- --language zh-TW --rounds 10 --seed 7 --out harness.md
// Uses the offline rule-based DM; real providers plug in through the same ports.
const { values } = parseArgs({
  options: {
    language: { type: "string", default: "both" },
    rounds: { type: "string", default: "8" },
    seed: { type: "string", default: "1" },
    out: { type: "string" },
  },
});

const languages: readonly CampaignLanguage[] =
  values.language === "both" ? ["en", "zh-TW"] : values.language === "en" || values.language === "zh-TW" ? [values.language] : [];
const rounds = Number(values.rounds);
const seed = Number(values.seed);
if (languages.length === 0 || !Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(seed)) {
  process.stderr.write("Usage: campaign-harness [--language en|zh-TW|both] [--rounds N] [--seed N] [--out file.md]\n");
  process.exit(1);
}

const glossaries = { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary } as const;
const content = buildSrd51({ capabilities: milestone0Capabilities, glossaries: [enSrd51Glossary, zhTwSrd51Glossary] });
const adventure = loadStarterAdventure();
const reports: string[] = [];
let problems = 0;

for (const language of languages) {
  const run = await runHarness({
    adventure: adventure[language],
    players: defaultHarnessPlayers,
    planner: new RuleBasedPlanner(),
    narrator: new TemplateNarrator(),
    random: new SeededRandomSource(seed),
    rulesets: new RulesetCatalog([content]),
    rulesetPin: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
    glossary: glossaries[language],
    unitOfWork: new InMemoryCampaignStore(),
    rounds,
  });
  const report = summarizeRun(run);
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
