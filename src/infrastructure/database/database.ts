import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema.js";

export interface DatabaseConnection {
  database: PostgresJsDatabase<typeof schema>;
  close(): Promise<void>;
}

// Derives a Postgres schema name from an instance name — unquoted Postgres
// identifiers can't contain hyphens, so they're folded to underscores.
// `instanceNamePattern` (config/instance-environment.ts) already restricts
// instance names to [a-z0-9_-], so this is the only translation needed.
// Exported so validateInstanceIsolation can detect the (rare) case where two
// differently-hyphenated instance names would fold to the same schema.
export function resolveInstanceSchemaName(instanceName: string): string {
  return instanceName.replaceAll("-", "_");
}

// `schemaName` is optional and purely additive: omitted (or null), this
// behaves exactly as before — a plain connection against the database's
// default (public) schema, one database per instance. Passed, every query
// on this connection resolves against that schema instead, letting multiple
// instances share one Postgres server without losing isolation from each
// other (see docs/launch-cheatsheet.md).
export async function createDatabaseConnection(
  databaseUrl: string,
  schemaName?: string | null,
): Promise<DatabaseConnection> {
  if (schemaName) {
    const bootstrapClient = postgres(databaseUrl, { max: 1 });
    try {
      // `sql(name)` is postgres-js's identifier-safe interpolation (distinct
      // from a parameterized value) — required here since schema names
      // can't be bound as a query parameter. `schemaName` is additionally
      // already restricted to [a-z0-9_] by resolveInstanceSchemaName.
      await bootstrapClient`CREATE SCHEMA IF NOT EXISTS ${bootstrapClient(schemaName)}`;
    } finally {
      await bootstrapClient.end();
    }
  }
  const client: Sql = postgres(databaseUrl, {
    max: 5,
    ...(schemaName ? { connection: { search_path: schemaName } } : {}),
  });
  return {
    database: drizzle(client, { schema }),
    close: async () => client.end(),
  };
}
