import "dotenv/config";

import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for database migrations.");

// Opt-in (PERSISTENCE_SCHEMA_PER_INSTANCE=true) — mirrors
// ApplicationConfiguration.persistence.schemaPerInstance /
// resolveInstanceSchemaName in src/infrastructure/database/database.ts.
// Unset (the default), this migrates the default/public schema exactly as
// before, regardless of whether INSTANCE_NAME happens to be set.
const instanceName = process.env.INSTANCE_NAME;
const schemaPerInstance = process.env.PERSISTENCE_SCHEMA_PER_INSTANCE === "true";
const schemaName = schemaPerInstance && instanceName ? instanceName.replaceAll("-", "_") : null;

// Postgres' `options=-c search_path=...` connection parameter, honored by
// every client library (not just postgres-js), so drizzle-kit's own
// connection picks up the same schema the app runtime does. The schema
// itself must already exist — see scripts/migrate-instance-database.ts,
// which creates it before spawning this config.
const scopedDatabaseUrl = schemaName
  ? `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schemaName}`)}`
  : databaseUrl;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/database/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: scopedDatabaseUrl },
  // Keeps each instance's migration-tracking table inside its own schema —
  // sharing one (the "drizzle" default) across instances would wrongly mark
  // instance B as already migrated once instance A's migrations ran.
  ...(schemaName ? { migrations: { schema: schemaName } } : {}),
  strict: true,
  verbose: true,
});
