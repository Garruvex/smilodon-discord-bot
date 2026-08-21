import concurrently, { type ConcurrentlyCommandInput } from "concurrently";

import { loadConfiguration } from "../config/environment.js";
import {
  loadInstanceEnvironment,
  loadSharedEnvironment,
} from "../config/instance-environment.js";

const sharedEnvironment = loadSharedEnvironment();
const name = sharedEnvironment.DEFAULT_INSTANCE;
if (!name) {
  throw new Error("DEFAULT_INSTANCE is missing from .env.");
}

const instance = loadInstanceEnvironment(name);
const configuration = loadConfiguration(instance.environment);

const commands: ConcurrentlyCommandInput[] = [
  {
    command: "npm.cmd run local:lavalink",
    name: "lavalink",
    prefixColor: "magenta",
    env: sharedEnvironment,
  },
];
if (configuration.persistence.driver === "postgres") {
  commands.push({
    command: "npm.cmd run local:postgres",
    name: "postgres",
    prefixColor: "green",
    env: sharedEnvironment,
  });
}
commands.push({
  command: "npm.cmd run local:bot",
  name,
  prefixColor: "cyan",
  env: instance.environment,
});

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
