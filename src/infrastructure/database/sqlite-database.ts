import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./sqlite-schema.js";

export interface SqliteDatabaseConnection {
  database: BetterSQLite3Database<typeof schema>;
  close(): void;
}

// Local (dev-only) backend for SqliteChatStateStore/SqliteGuildKnowledgeStore
// (see persistence-factory.ts) — one file at
// <runtimeDataDirectory>/chat.sqlite. Migrations are applied
// programmatically here rather than via a manual CLI step (unlike the
// Postgres side's `npm run db:migrate`), since this is a dev-only backend
// with no ops/multi-instance concern — it should just work on first run.
export function createSqliteDatabaseConnection(runtimeDataDirectory: string): SqliteDatabaseConnection {
  const file = resolve(runtimeDataDirectory, "chat.sqlite");
  mkdirSync(dirname(file), { recursive: true });
  const client = new Database(file);
  client.pragma("journal_mode = WAL");
  const database = drizzle(client, { schema });
  migrate(database, { migrationsFolder: resolve(process.cwd(), "drizzle-sqlite") });
  return {
    database,
    close: () => client.close(),
  };
}
