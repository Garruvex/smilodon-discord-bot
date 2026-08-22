import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadSharedEnvironment } from "../config/instance-environment.js";

const name = process.argv[2];
if (!name || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
  throw new Error("Provide a safe instance name, for example: myinstance");
}
const source = loadSharedEnvironment();
const required = ["DISCORD_TOKEN", "DISCORD_APPLICATION_ID", "BOT_OWNER_IDS"] as const;
for (const key of required) {
  if (!source[key]) throw new Error(`The legacy .env is missing ${key}.`);
}
const directory = resolve("config", "instances");
const file = resolve(directory, `${name}.env`);
mkdirSync(directory, { recursive: true });
const values = [
  `INSTANCE_NAME=${name}`,
  "",
  `DISCORD_TOKEN=${source.DISCORD_TOKEN}`,
  `DISCORD_APPLICATION_ID=${source.DISCORD_APPLICATION_ID}`,
  `BOT_OWNER_IDS=${source.BOT_OWNER_IDS}`,
  "",
  `PERSISTENCE_DRIVER=${source.PERSISTENCE_DRIVER ?? "file"}`,
  `GUILD_CONFIG_DIRECTORY=${source.GUILD_CONFIG_DIRECTORY ?? "./config/local/guilds"}`,
  `RUNTIME_DATA_DIRECTORY=${source.RUNTIME_DATA_DIRECTORY ?? "./data/local"}`,
  "",
].join("\n");
writeFileSync(file, values, { encoding: "utf8", flag: "wx" });
process.stdout.write(`Created ${file}\n`);
