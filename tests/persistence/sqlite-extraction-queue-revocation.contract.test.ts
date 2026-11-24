import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqlitePersonalMemoryExtractionQueueStore } from "../../src/infrastructure/persistence/sqlite-personal-memory-extraction-queue-store.js";
import { extractionQueueRevocationContract } from "./extraction-queue-revocation-contract.js";

extractionQueueRevocationContract("sqlite", () =>
  Promise.resolve(new SqlitePersonalMemoryExtractionQueueStore(createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "sqlite-extraction-revocation-"))).database)));
