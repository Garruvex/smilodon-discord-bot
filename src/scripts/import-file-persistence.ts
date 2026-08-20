import "dotenv/config";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { guildConfigurationFileSchema } from "../config/guild-configuration-schema.js";
import { createDatabaseConnection } from "../infrastructure/database/database.js";
import * as schema from "../infrastructure/database/schema.js";

const panelStateSchema = z.record(
  z.string(),
  z.object({ guildId: z.string(), channelId: z.string(), messageId: z.string() }),
);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for file import.");

const guildDirectory = resolve(
  process.env.GUILD_CONFIG_DIRECTORY ?? "./config/local/guilds",
);
const panelStateFile = resolve(
  process.env.RUNTIME_DATA_DIRECTORY ?? "./data/local",
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

const connection = await createDatabaseConnection(databaseUrl);
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
