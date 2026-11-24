import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { messageRevocationStoreContract } from "./message-revocation-store-contract.js";

messageRevocationStoreContract("sqlite", () => {
  // A fresh database per test also checks that the migrations create the tables on initialization.
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "sqlite-revocation-contract-")));
  return Promise.resolve(new SqliteMessageRevocationStore(connection.database));
});
