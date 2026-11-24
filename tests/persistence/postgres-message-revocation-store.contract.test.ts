// Runs the shared MessageRevocationStore contract against a real Postgres instance. Skipped by
// default; set MEMORY_TEST_DATABASE_URL to a disposable database, as for the memory contract.
import { describe, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { PostgresMessageRevocationStore } from "../../src/infrastructure/persistence/postgres-message-revocation-store.js";
import * as schema from "../../src/infrastructure/database/schema.js";
import { messageRevocationStoreContract } from "./message-revocation-store-contract.js";

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL;

if (!databaseUrl) {
  describe.skip("MessageRevocationStore contract (postgres)", () => {
    it("requires MEMORY_TEST_DATABASE_URL to run", () => {});
  });
} else {
  const client = postgres(databaseUrl, { max: 10 });
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });

  messageRevocationStoreContract("postgres", async () => {
    await database.execute(sql`TRUNCATE TABLE message_revocations, message_revocation_scopes, message_cleanup_work`);
    return new PostgresMessageRevocationStore(database);
  });
}
