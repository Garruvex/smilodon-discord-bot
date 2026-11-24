// Runs the shared ProvenanceGraphStore contract against a real Postgres instance. Skipped by default;
// set MEMORY_TEST_DATABASE_URL to a disposable database, as for the memory contract.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, it } from "vitest";
import { z } from "zod";

import * as schema from "../../src/infrastructure/database/schema.js";
import { PostgresMessageRevocationStore } from "../../src/infrastructure/persistence/postgres-message-revocation-store.js";
import { PostgresProvenanceGraphStore } from "../../src/infrastructure/persistence/postgres-provenance-graph-store.js";
import { provenanceGraphStoreContract } from "./provenance-graph-store-contract.js";

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL;

if (!databaseUrl) {
  describe.skip("ProvenanceGraphStore contract (postgres)", () => {
    it("requires MEMORY_TEST_DATABASE_URL to run", () => {});
  });
} else {
  const client = postgres(databaseUrl, { max: 10, onnotice: () => undefined });
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });
  const count = async (query: ReturnType<typeof sql>): Promise<number> => z.object({ count: z.coerce.number() }).parse((await database.execute(query))[0]).count;

  provenanceGraphStoreContract("postgres", async () => {
    await database.execute(sql`DROP TRIGGER IF EXISTS fail_pointer_writes ON provenance_current`);
    await database.execute(sql`TRUNCATE TABLE provenance_edges, provenance_current, provenance_revisions, message_revocations, message_revocation_scopes, message_cleanup_work`);
    return {
      store: new PostgresProvenanceGraphStore(database),
      revocations: new PostgresMessageRevocationStore(database),
      insertRevision: async (row): Promise<void> => { await database.insert(schema.provenanceRevisions).values({ guildId: "guild", channelId: "channel", completeness: "complete", createdAt: new Date(1), ...row,
        kind: row.kind as never }); },
      revisionCount: (): Promise<number> => count(sql`SELECT count(*) AS count FROM provenance_revisions`),
      edgeCount: (): Promise<number> => count(sql`SELECT count(*) AS count FROM provenance_edges`),
      scopeOrdinal: async (guildId, channelId): Promise<number> => {
        const rows = await database.execute(sql`SELECT ordinal FROM message_revocation_scopes WHERE guild_id = ${guildId} AND channel_id = ${channelId}`);
        return rows[0] ? z.object({ ordinal: z.coerce.number() }).parse(rows[0]).ordinal : 0;
      },
      failPointerWrites: async (): Promise<void> => {
        await database.execute(sql`CREATE OR REPLACE FUNCTION fail_pointer_writes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'interrupted'; END $$`);
        await database.execute(sql`CREATE TRIGGER fail_pointer_writes BEFORE INSERT OR UPDATE ON provenance_current FOR EACH ROW EXECUTE FUNCTION fail_pointer_writes()`);
      },
    };
  });
}
