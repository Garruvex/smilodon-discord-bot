import { spawnSync } from "node:child_process";

import { loadInstanceEnvironment } from "../config/instance-environment.js";
import { activateRequestedInstance } from "./instance-script-support.js";

const name = activateRequestedInstance(process.argv.slice(2));
const instance = loadInstanceEnvironment(name);
if (instance.environment.PERSISTENCE_DRIVER !== "postgres") {
  throw new Error(`Instance "${name}" does not use PostgreSQL persistence.`);
}
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmExecutable, ["run", "db:migrate"], {
  cwd: process.cwd(),
  env: instance.environment,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
