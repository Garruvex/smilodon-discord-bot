import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDatabaseConnection } from "../../src/infrastructure/database/database.js";

const databaseUrl = process.env.POSTGRES_MIGRATION_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL alias migration recovery", () => {
  it("rolls back the incompatible foreign key, then retries without losing existing memories", async () => {
    const schemaName = `alias_migration_${randomUUID().replaceAll("-", "")}`;
    const connection = await createDatabaseConnection(databaseUrl!, schemaName);
    const directory = mkdtempSync(join(tmpdir(), "alias-migration-"));
    expect(directory.startsWith(join(tmpdir(), "alias-migration-"))).toBe(true);
    const migration = readFileSync("drizzle/0021_old_moon_knight.sql", "utf8");
    const path = join(directory, "0021_old_moon_knight.sql");
    const memoryId = "00000000-0000-4000-8000-000000000001";
    try {
      // Only migration 0021's existing prerequisites are needed. This test
      // runs on plain PostgreSQL, independently of the optional pgvector
      // contract suite and without changing any live instance schema.
      await connection.database.execute(sql.raw(`CREATE TABLE memories (id uuid PRIMARY KEY, statement text NOT NULL);
        CREATE TABLE memory_sources (id uuid PRIMARY KEY);
        CREATE TABLE personal_memory_extraction_jobs (id uuid PRIMARY KEY);`));
      await connection.database.execute(sql`INSERT INTO memories (id, statement) VALUES (${memoryId}::uuid, 'existing fact')`);
      mkdirSync(join(directory, "meta"));
      writeFileSync(join(directory, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [
        { idx: 21, version: "7", when: 1791981831666, tag: "0021_old_moon_knight", breakpoints: true },
      ] }));
      writeFileSync(path, migration.replace('"memory_id" uuid NOT NULL', '"memory_id" text NOT NULL'));
      await expect(migrate(connection.database, { migrationsFolder: directory, migrationsSchema: schemaName }))
        .rejects.toMatchObject({ cause: { code: "42804" } });
      const absent = await connection.database.execute(sql`SELECT to_regclass(${`${schemaName}.memory_observed_aliases`}) AS relation`);
      expect(z.object({ relation: z.null() }).parse(absent[0]).relation).toBeNull();
      writeFileSync(path, migration);
      await migrate(connection.database, { migrationsFolder: directory, migrationsSchema: schemaName });
      await migrate(connection.database, { migrationsFolder: directory, migrationsSchema: schemaName });
      const types = await connection.database.execute(sql`SELECT udt_name FROM information_schema.columns
        WHERE table_schema = ${schemaName} AND table_name = 'memory_observed_aliases' AND column_name = 'memory_id'`);
      expect(z.object({ udt_name: z.string() }).parse(types[0]).udt_name).toBe("uuid");
      const memories = await connection.database.execute(sql`SELECT statement FROM memories WHERE id = ${memoryId}::uuid`);
      expect(z.object({ statement: z.string() }).parse(memories[0]).statement).toBe("existing fact");
      await connection.database.execute(sql`INSERT INTO memory_observed_aliases (guild_id, alias, memory_id) VALUES ('guild', 'Alice', ${memoryId}::uuid)`);
      await connection.database.execute(sql`DELETE FROM memories WHERE id = ${memoryId}::uuid`);
      expect(await connection.database.execute(sql`SELECT alias FROM memory_observed_aliases`)).toHaveLength(0);
    } finally {
      await connection.database.execute(sql`DROP SCHEMA ${sql.identifier(schemaName)} CASCADE`);
      await connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
