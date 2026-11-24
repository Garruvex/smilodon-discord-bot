import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { summarizeAnchorLog } from "../application/diagnostics/anchor-log-summary.js";

// Usage: docker compose logs --no-log-prefix bot | npm run -s logs:anchor
//    or: npm run -s logs:anchor -- path/to/bot.log
async function main(): Promise<void> {
  const path = process.argv[2];
  const lines: string[] = [];
  for await (const line of createInterface({ input: path ? createReadStream(path, "utf8") : process.stdin, crlfDelay: Infinity })) lines.push(line);
  const summary = summarizeAnchorLog(lines);
  process.stdout.write(`${JSON.stringify({ ...summary, firstAt: summary.firstAt && new Date(summary.firstAt).toISOString(), lastAt: summary.lastAt && new Date(summary.lastAt).toISOString() }, null, 2)}\n`);
  if (!summary.observed) process.stdout.write("No anchor observations: set character.context.priorAnswerAnchor to shadow or on for a guild first.\n");
}

await main();
