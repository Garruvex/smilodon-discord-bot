import { existsSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";

import { loadConfiguration } from "../config/environment.js";
import { createDatabaseConnection, resolveInstanceSchemaName } from "../infrastructure/database/database.js";
import { importSqliteCampaigns } from "../infrastructure/persistence/campaign/import-sqlite-campaigns.js";

// Copies the campaign data the bot kept in <RUNTIME_DATA_DIRECTORY>/campaign.sqlite
// into PostgreSQL, for an instance switching its persistence to PostgreSQL
// (run `npm run instance:db:migrate` first so the tables exist). Safe to run
// twice: rows already in PostgreSQL are left alone. Stop the bot first, so no
// game moves while it copies; the SQLite file is only read, never changed.
const configuration = loadConfiguration();
if (configuration.persistence.driver !== "postgres" || !configuration.persistence.databaseUrl || !configuration.instanceName) {
  throw new Error("PostgreSQL persistence, DATABASE_URL and INSTANCE_NAME are required.");
}
const file = resolve(configuration.runtimeDataDirectory, "campaign.sqlite");
if (!existsSync(file)) {
  process.stdout.write(`No campaign database at ${file}; nothing to import.\n`);
  process.exit(0);
}
const sqlite = new Database(file, { readonly: true, fileMustExist: true });
const connection = await createDatabaseConnection(configuration.persistence.databaseUrl, resolveInstanceSchemaName(configuration.instanceName));
try {
  const counts = await importSqliteCampaigns(sqlite, connection.database);
  process.stdout.write(`Imported into PostgreSQL: ${JSON.stringify(counts)}\n`);
} finally {
  sqlite.close();
  await connection.close();
}
