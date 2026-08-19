import concurrently, { type ConcurrentlyCommandInput } from "concurrently";

import {
  discoverInstanceNames,
  loadInstanceEnvironment,
  validateInstanceIsolation,
} from "../config/instance-environment.js";

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : discoverInstanceNames();
if (names.length === 0) {
  throw new Error("No instance .env files were found under config/instances.");
}
const instances = names.map((name) => loadInstanceEnvironment(name));
validateInstanceIsolation(instances);
const colors = ["cyan", "green", "yellow", "blue"] as const;

const commands: ConcurrentlyCommandInput[] = instances.map((instance, index) => ({
  command: "npm.cmd run local:bot",
  name: instance.name,
  prefixColor: colors[index % colors.length]!,
  env: instance.environment,
}));

const result = concurrently(commands, {
  cwd: process.cwd(),
  killOthersOn: ["failure"],
  prefix: "name",
  padPrefix: true,
});

try {
  await result.result;
} catch {
  process.exitCode = 1;
}
