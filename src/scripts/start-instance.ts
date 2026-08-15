import concurrently from "concurrently";

import { loadInstanceEnvironment } from "../config/instance-environment.js";
import { activateRequestedInstance } from "./instance-script-support.js";

const name = activateRequestedInstance(process.argv.slice(2));
const instance = loadInstanceEnvironment(name);
const result = concurrently(
  [{ command: "npm.cmd run local:bot", name, prefixColor: "cyan", env: instance.environment }],
  { cwd: process.cwd(), prefix: "name" },
);
try {
  await result.result;
} catch {
  process.exitCode = 1;
}
