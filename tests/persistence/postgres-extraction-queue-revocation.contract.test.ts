// Runs the extraction-queue revocation contract against a real Postgres instance. Skipped by
// default; set MEMORY_TEST_DATABASE_URL to a disposable database, as for the memory contract.
import { describe, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { PostgresPersonalMemoryExtractionQueueStore } from "../../src/infrastructure/persistence/postgres-personal-memory-extraction-queue-store.js";
import * as schema from "../../src/infrastructure/database/schema.js";
import { extractionQueueRevocationContract } from "./extraction-queue-revocation-contract.js";

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL;

if (!databaseUrl) {
  describe.skip("PersonalMemoryExtractionQueueStore deleteCitingMessages (postgres)", () => {
    it("requires MEMORY_TEST_DATABASE_URL to run", () => {});
  });
} else {
  const client = postgres(databaseUrl, { max: 5 });
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });

  extractionQueueRevocationContract("postgres", async () => {
    await database.execute(sql`TRUNCATE TABLE personal_memory_extraction_jobs`);
    return new PostgresPersonalMemoryExtractionQueueStore(database);
  });
}
