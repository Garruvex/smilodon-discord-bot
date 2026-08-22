import "dotenv/config";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { loadConfiguration } from "../config/environment.js";
import { guildConfigurationFileSchema } from "../config/guild-configuration-schema.js";
import {
  createDatabaseConnection,
  resolveInstanceSchemaName,
} from "../infrastructure/database/database.js";
import * as schema from "../infrastructure/database/schema.js";

const panelStateSchema = z.record(
  z.string(),
  z.object({ guildId: z.string(), channelId: z.string(), messageId: z.string() }),
);

const configuration = loadConfiguration();
const databaseUrl = configuration.persistence.databaseUrl;
if (configuration.persistence.driver !== "postgres" || !databaseUrl) {
  throw new Error("PostgreSQL persistence and DATABASE_URL are required for file import.");
}
if (!configuration.instanceName) {
  throw new Error("INSTANCE_NAME is required for PostgreSQL schema isolation.");
}

const guildDirectory = resolve(configuration.guildConfigurationDirectory);
const panelStateFile = resolve(
  configuration.runtimeDataDirectory,
  "control-panels.json",
);

const guildDocuments = readdirSync(guildDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
  .map((entry) => {
    const source = resolve(guildDirectory, entry.name);
    return guildConfigurationFileSchema.parse(parseYaml(readFileSync(source, "utf8")));
  });

const panelStates = existsSync(panelStateFile)
  ? Object.values(panelStateSchema.parse(JSON.parse(readFileSync(panelStateFile, "utf8"))))
  : [];

const connection = await createDatabaseConnection(
  databaseUrl,
  resolveInstanceSchemaName(configuration.instanceName),
);
try {
  await connection.database.transaction(async (transaction) => {
    for (const document of guildDocuments) {
      await transaction
        .insert(schema.guildConfigurations)
        .values({ guildId: document.guild.id, configuration: document })
        .onConflictDoNothing();
    }
    for (const state of panelStates) {
      await transaction
        .insert(schema.controlPanels)
        .values(state)
        .onConflictDoNothing();
    }
  });
} finally {
  await connection.close();
}

process.stdout.write(
  `Imported up to ${guildDocuments.length} guild profiles and ${panelStates.length} control panels. Existing PostgreSQL records were preserved.\n`,
);
