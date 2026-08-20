import { spawnSync } from "node:child_process";

import { loadInstanceEnvironment } from "../config/instance-environment.js";
import { createDatabaseConnection, resolveInstanceSchemaName } from "../infrastructure/database/database.js";
import { activateRequestedInstance } from "./instance-script-support.js";

const name = activateRequestedInstance(process.argv.slice(2));
const instance = loadInstanceEnvironment(name);
if (instance.environment.PERSISTENCE_DRIVER !== "postgres") {
  throw new Error(`Instance "${name}" does not use PostgreSQL persistence.`);
}
const databaseUrl = instance.environment.DATABASE_URL;
if (!databaseUrl) throw new Error(`Instance "${name}" is missing DATABASE_URL.`);

// Opt-in (PERSISTENCE_SCHEMA_PER_INSTANCE=true), same gate as
// persistence-factory.ts / drizzle.config.ts. Ensures the instance's schema
// exists before drizzle.config.ts's scoped connection tries to migrate into
// it — CREATE SCHEMA isn't something drizzle-kit does on its own.
if (instance.environment.PERSISTENCE_SCHEMA_PER_INSTANCE === "true") {
  const schemaName = resolveInstanceSchemaName(name);
  const bootstrapConnection = await createDatabaseConnection(databaseUrl, schemaName);
  await bootstrapConnection.close();
}

const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmExecutable, ["run", "db:migrate"], {
  cwd: process.cwd(),
  env: instance.environment,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
