import { readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// drizzle-kit generate only diffs schema.ts against the newest
// meta/NNNN_snapshot.json, and the runtime migrator only reads the .sql files
// plus meta/_journal.json — so older snapshots are dead weight. Runs after
// each generate to keep exactly one per migrations folder (git history
// still has the rest).
// Usage: tsx src/scripts/prune-migration-snapshots.ts <migrations-dir>...
const directories = process.argv.slice(2);
if (directories.length === 0) {
  throw new Error("Usage: tsx src/scripts/prune-migration-snapshots.ts <migrations-dir>...");
}

for (const directory of directories) {
  const metaDirectory = resolve(directory, "meta");
  const snapshots = readdirSync(metaDirectory).filter((file) => /^\d+_snapshot\.json$/.test(file)).sort();
  const stale = snapshots.slice(0, -1);
  for (const file of stale) rmSync(resolve(metaDirectory, file));
  if (stale.length > 0) {
    process.stdout.write(`Pruned ${stale.length} old snapshot(s) from ${metaDirectory}; kept ${snapshots.at(-1)}.\n`);
  }
}
