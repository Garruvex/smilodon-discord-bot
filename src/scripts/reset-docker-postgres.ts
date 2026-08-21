import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";

import { loadSharedEnvironment } from "../config/instance-environment.js";

const environment = loadSharedEnvironment();
const dataRoot = resolve(environment.DATA_ROOT?.trim() || "./data");
const postgresDirectory = resolve(dataRoot, "postgres");
if (relative(dataRoot, postgresDirectory) !== "postgres") {
  throw new Error(`Refusing to reset unexpected PostgreSQL path: ${postgresDirectory}`);
}

runDocker(["compose", "down", "--remove-orphans"]);
rmSync(postgresDirectory, { recursive: true, force: true });
mkdirSync(postgresDirectory, { recursive: true });
process.stdout.write(`Removed PostgreSQL data: ${postgresDirectory}\n`);
runDocker(["compose", "up", "--build", "-d", "--wait", "--remove-orphans"]);

function runDocker(arguments_: readonly string[]): void {
  const result = spawnSync("docker", arguments_, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
