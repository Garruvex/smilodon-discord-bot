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

// Every application connection resolves its instance schema first. `public`
// remains second only so database-wide extension objects such as pgvector's
// `vector` type and operator classes are visible to migrations and queries.
export async function createDatabaseConnection(
  databaseUrl: string,
  schemaName: string,
): Promise<DatabaseConnection> {
  const bootstrapClient = postgres(databaseUrl, { max: 1 });
  try {
    // `sql(name)` is postgres-js's identifier-safe interpolation (distinct
    // from a parameterized value). Instance names are restricted to a safe
    // character set before being converted by resolveInstanceSchemaName.
    await bootstrapClient`CREATE SCHEMA IF NOT EXISTS ${bootstrapClient(schemaName)}`;
  } finally {
    await bootstrapClient.end();
  }
  const client: Sql = postgres(databaseUrl, {
    max: 5,
    connection: { search_path: `${schemaName},public` },
  });
  return {
    database: drizzle(client, { schema }),
    close: async () => client.end(),
  };
}
