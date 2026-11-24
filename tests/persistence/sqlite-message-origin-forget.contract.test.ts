import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMessageOriginStore } from "../../src/infrastructure/persistence/sqlite-message-origin-store.js";
import { messageOriginForgetContract } from "./message-origin-forget-contract.js";

messageOriginForgetContract("sqlite", () =>
  Promise.resolve(new SqliteMessageOriginStore(createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "sqlite-origin-forget-"))).database)));
