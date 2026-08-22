// Runs the shared MemoryRepository contract against a real Postgres+pgvector
// instance. Skipped by default — set MEMORY_TEST_DATABASE_URL (pointing at a
// disposable pgvector-enabled database) to run it, e.g.:
//   docker run -d -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=test -p 55432:5432 pgvector/pgvector:pg16
//   MEMORY_TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55432/test npm test
import { describe, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { PostgresMemoryRepository } from "../../src/infrastructure/persistence/postgres-memory-repository.js";
import * as schema from "../../src/infrastructure/database/schema.js";
import { memoryRepositoryContract } from "./memory-repository-contract.js";

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL;

if (!databaseUrl) {
  describe.skip("MemoryRepository contract (postgres)", () => {
    it("requires MEMORY_TEST_DATABASE_URL to run — see this file's header comment", () => {});
  });
} else {
  const client = postgres(databaseUrl, { max: 5 });
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });

  memoryRepositoryContract("postgres", async () => {
    // Each test gets a clean slate on the shared connection/schema rather
    // than a fresh database — cheaper than provisioning per-test, and the
    // contract's own assertions never depend on cross-test isolation beyond
    // "no leftover rows".
    await database.execute(sql`TRUNCATE TABLE memory_sources, memories`);
    return new PostgresMemoryRepository(database);
  });
}
