import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const checkOnly = process.argv.includes("--check");
const directoryArgumentIndex = process.argv.indexOf("--directory");
const directory = resolve(
  directoryArgumentIndex >= 0 ? process.argv[directoryArgumentIndex + 1] ?? "drizzle" : "drizzle",
);
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
const affected: string[] = [];

for (const file of files) {
  const path = resolve(directory, file);
  const source = readFileSync(path, "utf8");
  const normalized = source.replaceAll('"public".', "");
  if (normalized === source) continue;
  affected.push(file);
  if (!checkOnly) writeFileSync(path, normalized, "utf8");
}

if (checkOnly && affected.length > 0) {
  throw new Error(
    `PostgreSQL migrations must be instance-schema portable; normalize: ${affected.join(", ")}`,
  );
}
if (!checkOnly) {
  process.stdout.write(`Normalized ${affected.length} PostgreSQL migration file(s).\n`);
}
