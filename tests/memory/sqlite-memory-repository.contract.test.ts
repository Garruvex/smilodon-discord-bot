import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { memoryRepositoryContract } from "./memory-repository-contract.js";

memoryRepositoryContract("sqlite", () => {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-memory-contract-"));
  const connection = createSqliteDatabaseConnection(directory);
  return Promise.resolve(new SqliteMemoryRepository(connection.database));
});
