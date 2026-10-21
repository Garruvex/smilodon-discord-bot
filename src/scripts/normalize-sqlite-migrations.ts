import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeSqliteMigration } from "../infrastructure/database/sqlite-migration-normalization.js";

const directory = resolve("drizzle-sqlite"); const checkOnly = process.argv.includes("--check");
const affected: string[] = [];
for (const file of readdirSync(directory).filter((entry) => entry.endsWith(".sql")).sort()) {
  const path = resolve(directory, file); const source = readFileSync(path, "utf8"); const normalized = normalizeSqliteMigration(source);
  if (source === normalized) continue;
  affected.push(file); if (!checkOnly) writeFileSync(path, normalized, "utf8");
}
if (checkOnly && affected.length) throw new Error(`Invalid generated SQLite expression indexes; normalize: ${affected.join(", ")}`);
if (!checkOnly) process.stdout.write(`Normalized ${affected.length} SQLite migration file(s).\n`);
