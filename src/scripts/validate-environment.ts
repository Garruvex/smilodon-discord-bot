import { loadConfiguration } from "../config/environment.js";

const configuration = loadConfiguration();
const instance = configuration.instanceName ?? "default";

process.stdout.write(
  `Valid configuration: ${instance} (${configuration.persistence.driver}, ${configuration.guildConfigurationDirectory})\n`,
);
