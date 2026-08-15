import { loadConfiguration } from "../config/environment.js";
import { LocalGuildConfigurationProvider } from "../config/guild-configuration-provider.js";

const configuration = loadConfiguration();
const provider = new LocalGuildConfigurationProvider(
  configuration.guildConfigurationDirectory,
);
await provider.initialize();

for (const profile of provider.getAll()) {
  const enabledFeatures = Object.entries(profile.features)
    .filter(([, enabled]) => enabled)
    .map(([feature]) => feature)
    .join(", ");

  process.stdout.write(
    `Valid: ${profile.guildName} (${profile.guildId}) [${enabledFeatures}]\n`,
  );
}

process.stdout.write(`Validated ${provider.getAll().length} guild profile(s).\n`);
