// Runs the origin cleanup contract against a real Postgres instance. Skipped by default; set
// MEMORY_TEST_DATABASE_URL to a disposable database, as for the memory contract.
import { describe, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { PostgresMessageOriginStore } from "../../src/infrastructure/persistence/postgres-message-origin-store.js";
import * as schema from "../../src/infrastructure/database/schema.js";
import { messageOriginForgetContract } from "./message-origin-forget-contract.js";

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL;

if (!databaseUrl) {
  describe.skip("MessageOriginStore forgetCitingMessages (postgres)", () => {
    it("requires MEMORY_TEST_DATABASE_URL to run", () => {});
  });
} else {
  const client = postgres(databaseUrl, { max: 5 });
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });

  messageOriginForgetContract("postgres", async () => {
    await database.execute(sql`TRUNCATE TABLE message_origins`);
    return new PostgresMessageOriginStore(database);
  });
}
