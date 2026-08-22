import { resolve } from "node:path";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { loadConfiguration } from "../config/environment.js";
import {
  createDatabaseConnection,
  resolveInstanceSchemaName,
} from "../infrastructure/database/database.js";

const configuration = loadConfiguration();
if (configuration.persistence.driver !== "postgres" || !configuration.persistence.databaseUrl) {
  throw new Error("PostgreSQL persistence and DATABASE_URL are required for migrations.");
}

if (!configuration.instanceName) {
  throw new Error("INSTANCE_NAME is required for PostgreSQL schema isolation.");
}
const connection = await createDatabaseConnection(
  configuration.persistence.databaseUrl,
  resolveInstanceSchemaName(configuration.instanceName),
);
try {
  const schemaName = resolveInstanceSchemaName(configuration.instanceName);
  await migrate(connection.database, {
    migrationsFolder: resolve("drizzle"),
    migrationsSchema: schemaName,
  });
  process.stdout.write(`Migrated PostgreSQL schema "${schemaName}".\n`);
} finally {
  await connection.close();
}
