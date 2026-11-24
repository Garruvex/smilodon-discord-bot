// Migrates a populated v1 PostgreSQL schema to the provenance graph. Skipped by default; set
// PROVENANCE_MIGRATION_TEST_DATABASE_URL to an empty, disposable pgvector database. It must be empty
// because the test applies the migrations up to v1 itself.
import { resolve } from "node:path";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import * as schema from "../../src/infrastructure/database/schema.js";
import { PostgresMessageOriginStore } from "../../src/infrastructure/persistence/postgres-message-origin-store.js";
import { PostgresMessageRevocationStore } from "../../src/infrastructure/persistence/postgres-message-revocation-store.js";
import { expectV1ReadsAfterMigration, migrationsBeforeLatest, populateV1, revisionRow } from "./provenance-schema-contract.js";

const databaseUrl = process.env.PROVENANCE_MIGRATION_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("provenance graph schema (postgres)", () => {
  it("migrates a populated v1 database, keeps v1 reads and gives each output revision its own identity", async () => {
    const client = postgres(databaseUrl!, { max: 4, onnotice: () => undefined });
    const database = drizzle(client, { schema });
    try {
      const { previous, latestTag } = migrationsBeforeLatest(resolve("drizzle"));
      await migrate(database, { migrationsFolder: previous });
      expect(await database.execute(sql`SELECT to_regclass('provenance_revisions') AS relation`)).toEqual([{ relation: null }]);
      await populateV1(async (statement) => { await database.execute(sql.raw(statement)); }, "postgres");

      await migrate(database, { migrationsFolder: resolve("drizzle") });
      expect(latestTag).toMatch(/^0027_/u);
      await expectV1ReadsAfterMigration(new PostgresMessageRevocationStore(database), new PostgresMessageOriginStore(database));

      await database.insert(schema.provenanceRevisions).values([revisionRow("r1", 1, 1), revisionRow("r2", 2, 2)]);
      await expect(database.insert(schema.provenanceRevisions).values(revisionRow("r3", 2, 3))).rejects.toMatchObject({ cause: { code: "23505" } });
      await expect(database.insert(schema.provenanceRevisions).values(revisionRow("r4", 3, 2))).rejects.toMatchObject({ cause: { code: "23505" } });
      await database.insert(schema.provenanceRevisions).values({ ...revisionRow("other", 1, 1), channelId: "other" });
      await database.insert(schema.provenanceCurrent).values({ guildId: "guild", channelId: "channel", kind: "reply_part", artifactId: "reply", revisionId: "r2", version: 2 });
      await database.insert(schema.provenanceEdges).values([{ childId: "r2", parentId: "r1", projection: "full", representationHash: "a".repeat(64) },
        { childId: "r2", parentId: "r1", projection: "human_text:1000", representationHash: "b".repeat(64) }]);
      await expect(database.insert(schema.provenanceEdges).values({ childId: "r2", parentId: "r1", projection: "full", representationHash: "c".repeat(64) }))
        .rejects.toMatchObject({ cause: { code: "23505" } });
      // A dangling parent is refused by the foreign key.
      await expect(database.insert(schema.provenanceEdges).values({ childId: "r2", parentId: "missing", projection: "full", representationHash: "c".repeat(64) }))
        .rejects.toMatchObject({ cause: { code: "23503" } });
      expect(await database.select().from(schema.provenanceEdges).where(eq(schema.provenanceEdges.parentId, "r1"))).toHaveLength(2);
      expect(await database.select().from(schema.provenanceCurrent)).toEqual([expect.objectContaining({ revisionId: "r2", version: 2 })]);
    } finally {
      await client.end();
    }
  }, 60_000);
});
