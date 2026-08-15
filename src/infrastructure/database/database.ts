import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema.js";

export interface DatabaseConnection {
  database: PostgresJsDatabase<typeof schema>;
  close(): Promise<void>;
}

export function createDatabaseConnection(databaseUrl: string): DatabaseConnection {
  const client: Sql = postgres(databaseUrl, { max: 5 });
  return {
    database: drizzle(client, { schema }),
    close: async () => client.end(),
  };
}
