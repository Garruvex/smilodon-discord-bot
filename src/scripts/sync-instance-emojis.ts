import { Client, Events } from "discord.js";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { yohtaApplicationEmojiAssets } from "../config/application-emoji-presets.js";
import {
  discoverInstanceNames,
  loadInstanceEnvironment,
} from "../config/instance-environment.js";

const requestedNames = process.argv.slice(2);
const instanceNames = requestedNames.length > 0 ? requestedNames : discoverInstanceNames();
if (instanceNames.length === 0) {
  throw new Error("No configured instances were found.");
}

const assetDirectory = resolve("assets", "emojis", "yohta");

for (const instanceName of instanceNames) {
  await synchronizeInstance(instanceName);
}

async function synchronizeInstance(instanceName: string): Promise<void> {
  const instance = loadInstanceEnvironment(instanceName);
  const token = instance.environment.DISCORD_TOKEN?.trim();
  if (!token) throw new Error(`Instance "${instanceName}" is missing DISCORD_TOKEN.`);

  const client = new Client({ intents: [] });
  const ready = new Promise<void>((resolveReady) => {
    client.once(Events.ClientReady, () => resolveReady());
  });

  process.stdout.write(`Synchronizing application emojis for "${instanceName}"…\n`);
  try {
    await client.login(token);
    await ready;
    const application = client.application;
    if (!application) throw new Error("Discord application was unavailable after login.");
    const existing = await application.emojis.fetch();

    for (const asset of yohtaApplicationEmojiAssets) {
      const present = existing.find((emoji) => emoji.name === asset.name);
      if (present) {
        process.stdout.write(`  kept ${asset.name} (${present.id})\n`);
        continue;
      }

      const file = resolve(assetDirectory, asset.file);
      if (!existsSync(file) || !statSync(file).isFile()) {
        throw new Error(`Emoji asset is missing: ${file}`);
      }
      const created = await application.emojis.create({ attachment: file, name: asset.name });
      process.stdout.write(`  created ${asset.name} (${created.id})\n`);
    }

    process.stdout.write(`Synchronized "${instanceName}".\n`);
  } finally {
    await client.destroy();
  }
}
