import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadInstanceEnvironment } from "../config/instance-environment.js";

const name = process.argv[2];
if (!name) throw new Error("Provide the default instance name, for example: myinstance");
const instance = loadInstanceEnvironment(name);
for (const key of ["DISCORD_TOKEN", "DISCORD_APPLICATION_ID", "BOT_OWNER_IDS"] as const) {
  if (!instance.environment[key]) throw new Error(`Instance "${name}" is missing ${key}.`);
}

const environmentFile = resolve(".env");
const temporaryFile = `${environmentFile}.tmp`;
const instanceKeys = new Set([
  "DEFAULT_INSTANCE",
  "INSTANCE_NAME",
  "DISCORD_TOKEN",
  "DISCORD_APPLICATION_ID",
  "BOT_OWNER_IDS",
  "PERSISTENCE_DRIVER",
  "DATABASE_URL",
  "GUILD_CONFIG_DIRECTORY",
  "RUNTIME_DATA_DIRECTORY",
]);
const retained = readFileSync(environmentFile, "utf8")
  .split(/\r?\n/)
  .filter((line) => {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    return !match || !instanceKeys.has(match[1]!);
  });
while (retained.length > 0 && retained.at(-1)?.trim() === "") retained.pop();
retained.push("", `DEFAULT_INSTANCE=${name}`, "");
writeFileSync(temporaryFile, retained.join("\n"), "utf8");
renameSync(temporaryFile, environmentFile);
process.stdout.write(
  `Promoted "${name}" as DEFAULT_INSTANCE and removed application-specific values from .env.\n`,
);
