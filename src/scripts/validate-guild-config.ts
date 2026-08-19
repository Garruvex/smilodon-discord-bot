import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfiguration } from "../config/environment.js";
import { validateGuildConfigurationText } from "../config/guild-configuration-validation.js";

const explicitPath = process.argv[2];

if (explicitPath) {
  // Dry-run a single file (e.g. a draft sitting next to the live config)
  // without touching the guild configuration directory at all.
  const text = readFileSync(explicitPath, "utf8");
  const result = validateGuildConfigurationText(text);
  if (result.valid) {
    process.stdout.write(`Valid: ${explicitPath} (guild ${result.guildId})\n`);
  } else {
    process.stderr.write(`Invalid: ${explicitPath}\n`);
    for (const error of result.errors) process.stderr.write(`  - ${error}\n`);
    process.exitCode = 1;
  }
} else {
  const configuration = loadConfiguration();
  const directory = resolve(configuration.guildConfigurationDirectory);
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .filter((file) => statSync(resolve(directory, file)).isFile())
    .sort();

  const guildIdsSeen = new Map<string, string>();
  let invalidCount = 0;

  for (const file of files) {
    const sourceFile = resolve(directory, file);
    const result = validateGuildConfigurationText(readFileSync(sourceFile, "utf8"));
    if (!result.valid) {
      invalidCount += 1;
      process.stderr.write(`Invalid: ${file}\n`);
      for (const error of result.errors) process.stderr.write(`  - ${error}\n`);
      continue;
    }
    const previousFile = result.guildId ? guildIdsSeen.get(result.guildId) : undefined;
    if (result.guildId && previousFile) {
      invalidCount += 1;
      process.stderr.write(`Invalid: ${file}\n  - Guild "${result.guildId}" is already configured in "${previousFile}".\n`);
      continue;
    }
    if (result.guildId) guildIdsSeen.set(result.guildId, file);
    process.stdout.write(`Valid: ${file} (guild ${result.guildId})\n`);
  }

  process.stdout.write(`Validated ${files.length} guild profile(s); ${invalidCount} invalid.\n`);
  if (invalidCount > 0) process.exitCode = 1;
}
