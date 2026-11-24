import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import * as schema from "../../src/infrastructure/database/sqlite-schema.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { SqliteProvenanceGraphStore } from "../../src/infrastructure/persistence/sqlite-provenance-graph-store.js";
import { provenanceGraphStoreContract } from "./provenance-graph-store-contract.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

provenanceGraphStoreContract("sqlite", () => {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "provenance-graph-"))); close.push(() => connection.close());
  const { database } = connection;
  const count = (table: "provenance_revisions" | "provenance_edges"): number => database.get<{ count: number }>(sql.raw(`SELECT count(*) AS count FROM ${table}`)).count;
  return Promise.resolve({
    store: new SqliteProvenanceGraphStore(database),
    revocations: new SqliteMessageRevocationStore(database),
    insertRevision: (row) => { database.insert(schema.provenanceRevisions).values({ guildId: "guild", channelId: "channel", completeness: "complete", createdAt: new Date(1), ...row,
      kind: row.kind as never }).run(); return Promise.resolve(); },
    revisionCount: () => Promise.resolve(count("provenance_revisions")),
    edgeCount: () => Promise.resolve(count("provenance_edges")),
    scopeOrdinal: (guildId, channelId) => Promise.resolve(database.get<{ ordinal: number } | undefined>(
      sql`SELECT ordinal FROM message_revocation_scopes WHERE guild_id = ${guildId} AND channel_id = ${channelId}`)?.ordinal ?? 0),
    // The foreign key refuses this, so enforcement is off for this one insert.
    insertDanglingEdge: (childId, parentId) => {
      database.run(sql`PRAGMA foreign_keys = OFF`);
      try { database.insert(schema.provenanceEdges).values({ childId, parentId, projection: "full", representationHash: "c".repeat(64) }).run(); }
      finally { database.run(sql`PRAGMA foreign_keys = ON`); }
      return Promise.resolve();
    },
    failPointerWrites: () => {
      for (const event of ["INSERT", "UPDATE"]) database.run(sql.raw(`CREATE TRIGGER fail_pointer_${event} BEFORE ${event} ON provenance_current BEGIN SELECT RAISE(ABORT, 'interrupted'); END`));
      return Promise.resolve();
    },
  });
});
