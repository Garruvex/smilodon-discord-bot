import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { parseAdventureDocument } from "../application/campaign/adventures/adventure-document.js";
import { validateAdventure } from "../application/campaign/adventures/adventure-validator.js";
import { searchStoryStates, maxStates } from "../application/campaign/adventures/story-states.js";
import { analyzeStoryContract, type StoryFinding } from "../application/campaign/adventures/story-contract.js";
import { enSrd51Glossary } from "../application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { buildSrd51 } from "../domain/campaign/content/srd-5.1/index.js";
import { milestone0Capabilities } from "../domain/campaign/rules/capabilities.js";

// Checks adventure files against the format and the story contract (see docs/dnd-adventure-conversion-guide.md).
//   npm run adventure:check -- private/adventures/farm-fright/zh-TW.yaml
//   npm run adventure:check -- private/adventures            (every .yaml below it, with a summary)
// --routes prints the best way to each ending (every roll lands in the table's favour) and the worst case (every roll against them).
// Exit code 1 when any file has errors, so a converter can run it in a loop until it passes.
const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: "boolean", default: false }, quiet: { type: "boolean", default: false }, routes: { type: "boolean", default: false } } });
if (positionals.length === 0) {
  console.error("Usage: npm run adventure:check -- <file.yaml | folder> [--quiet] [--json] [--routes]");
  process.exit(2);
}

const content = buildSrd51({ capabilities: milestone0Capabilities, glossaries: [enSrd51Glossary, zhTwSrd51Glossary] });

function yamlFiles(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => yamlFiles(join(path, entry)));
}

interface FileResult {
  readonly file: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly story: readonly StoryFinding[];
}

const results: FileResult[] = yamlFiles(positionals[0] ?? "").filter((file) => file.endsWith(".yaml")).map((file) => {
  const source = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  const report = validateAdventure(source, content);
  let story: readonly StoryFinding[] = [];
  if (report.document !== null) story = analyzeStoryContract(parseAdventureDocument(source).bible);
  return { file, errors: report.errors, warnings: report.warnings, story };
});

if (values.routes) {
  for (const file of yamlFiles(positionals[0] ?? "").filter((candidate) => candidate.endsWith(".yaml"))) {
    const bible = parseAdventureDocument(readFileSync(file, "utf8").replaceAll("\r\n", "\n")).bible;
    const endings = bible.scenes.filter((scene) => scene.ending === true).map((scene) => scene.id);
    console.log(["", file].join("\n"));
    for (const ending of endings) {
      // Each ending on its own: the best way there, and whether the table can force it at all when every roll and fight goes against them.
      const found = searchStoryStates(bible, endings, maxStates * 10, 60_000, [ending]);
      if (found.kind !== "complete") { console.log(`  ${ending}: too many states to search`); continue; }
      const best = found.routes[ending];
      console.log(`  ${ending} (${found.states} states)`);
      console.log(best === undefined ? "    best case: cannot be reached" : ["    best case:", ...best.map((step, index) => `      ${index + 1}. ${step}`)].join("\n"));
      // Every roll fails, every fight is won: does the ending still open?
      const unlucky = searchStoryStates(bible, endings, maxStates * 10, 60_000, [ending], true);
      const unluckyRoute = unlucky.kind === "complete" ? unlucky.routes[ending] : undefined;
      console.log(unlucky.kind !== "complete" ? "    every roll fails, fights won: too many states to search" : unluckyRoute === undefined ? "    every roll fails, fights won: cannot be reached" : ["    every roll fails, fights won: reachable", ...unluckyRoute.map((step, index) => `      ${index + 1}. ${step}`)].join("\n"));
      console.log(found.worst.length === 0 ? "    worst case: not guaranteed, bad luck can keep the table from it (the other endings stay open)" : ["    worst case, forced:", ...found.worst.map((step, index) => `      ${index + 1}. ${step}`)].join("\n"));
    }
  }
  process.exit(0);
}
if (values.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const result of results) {
    const storyErrors = result.story.filter((finding) => finding.severity === "error");
    const clean = result.errors.length === 0 && result.story.length === 0 && result.warnings.length === 0;
    if (values.quiet && clean) continue;
    console.log(`\n${result.file}: ${result.errors.length + storyErrors.length === 0 ? "OK" : "FAILS"}`);
    for (const error of result.errors) console.log(`  error   ${error}`);
    for (const finding of result.story) console.log(`  ${finding.severity === "error" ? "error  " : "warning"} [${finding.rule}] ${finding.message}\n          fix: ${finding.fix}`);
    for (const warning of result.warnings) console.log(`  warning ${warning}`);
  }
  const failing = results.filter((result) => result.errors.length > 0 || result.story.some((finding) => finding.severity === "error"));
  const byRule = new Map<string, number>();
  for (const finding of results.flatMap((result) => result.story)) byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1);
  console.log(`\n${results.length} file(s), ${failing.length} with errors. Story findings by rule: ${[...byRule].map(([rule, count]) => `${rule} ${count}`).join(", ") || "none"}`);
}
process.exit(results.some((result) => result.errors.length > 0 || result.story.some((finding) => finding.severity === "error")) ? 1 : 0);
