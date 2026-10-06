import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";

import { createDatabaseConnection, type DatabaseConnection } from "../../../src/infrastructure/database/database.js";

export const campaignTables = [
  "campaign_campaigns",
  "campaign_records",
  "campaign_guild_settings",
  "campaign_events",
  "campaign_processed_commands",
  "campaign_outbox",
  "campaign_timers",
  "campaign_rolls",
  "campaign_library_characters",
  "campaign_library_snapshots",
  "campaign_adventures",
] as const;

export interface PostgresTestDatabase {
  readonly url: string;
  readonly schemaName: string;
  // A fresh connection, like a process that has just started.
  connect(): Promise<DatabaseConnection>;
  // Empties every campaign table.
  clear(connection: DatabaseConnection): Promise<void>;
}

// A PostgreSQL database to test against, when CAMPAIGN_TEST_DATABASE_URL names
// one (otherwise null and the tests are skipped). Each test file gets its own
// schema, made fresh from the campaign migration on its own: it needs nothing
// from the rest of the schema (the full chain wants pgvector, which a plain
// local server may not have).
export async function postgresTestDatabase(schemaName: string): Promise<PostgresTestDatabase | null> {
  const url = process.env.CAMPAIGN_TEST_DATABASE_URL;
  if (url === undefined || url === "") return null;
  const setup = await createDatabaseConnection(url, schemaName);
  try {
    await setup.database.execute(sql.raw(`DROP SCHEMA ${schemaName} CASCADE; CREATE SCHEMA ${schemaName};`));
    for (const statement of readFileSync("./drizzle/0019_campaign_store.sql", "utf8").split("--> statement-breakpoint")) {
      if (statement.trim() !== "") await setup.database.execute(sql.raw(statement));
    }
  } finally {
    await setup.close();
  }
  return {
    url,
    schemaName,
    connect: () => createDatabaseConnection(url, schemaName),
    clear: async (connection): Promise<void> => {
      await connection.database.execute(sql.raw(`TRUNCATE ${campaignTables.join(", ")} RESTART IDENTITY`));
    },
  };
}
