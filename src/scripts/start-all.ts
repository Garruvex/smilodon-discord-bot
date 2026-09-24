import concurrently, { type ConcurrentlyCommandInput } from "concurrently";

import { loadConfiguration } from "../config/environment.js";
import {
  discoverInstanceNames,
  loadInstanceEnvironment,
  loadSharedEnvironment,
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
const sharedEnvironment = loadSharedEnvironment();
// Local PostgreSQL only starts when at least one instance actually uses it,
// same rule as local:start for the default instance.
const needsPostgres = instances.some(
  (instance) => loadConfiguration(instance.environment).persistence.driver === "postgres",
);
const commands: ConcurrentlyCommandInput[] = [
  { command: "npm.cmd run local:lavalink", name: "lavalink", prefixColor: "magenta", env: sharedEnvironment },
  ...(needsPostgres
    ? [{ command: "npm.cmd run local:postgres", name: "postgres", prefixColor: "green", env: sharedEnvironment }]
    : []),
  ...instances.map((instance, index) => ({
    command: "npm.cmd run local:bot",
    name: instance.name,
    prefixColor: colors[index % colors.length]!,
    env: instance.environment,
  })),
];

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
