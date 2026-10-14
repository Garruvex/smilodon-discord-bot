import { readFileSync } from "node:fs";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../../src/infrastructure/database/schema.js";

describe("PostgreSQL foreign-key compatibility", () => {
  it("uses matching SQL types for every declared foreign key", () => {
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      const configuration = getTableConfig(table);
      for (const key of configuration.foreignKeys) {
        const reference = key.reference();
        reference.columns.forEach((column, index) => {
          expect(column.getSQLType(), `${configuration.name}.${column.name}`)
            .toBe(reference.foreignColumns[index]!.getSQLType());
        });
      }
    }
  });
  it("creates alias memory IDs as UUID before adding the migration's foreign key", () => {
    const migration = readFileSync("drizzle/0021_old_moon_knight.sql", "utf8");
    const definition = migration.match(/CREATE TABLE "memory_observed_aliases" \(([\s\S]*?)\n\);/u)?.[1];
    expect(definition).toMatch(/"memory_id" uuid NOT NULL/u);
    expect(getTableConfig(schema.memoryObservedAliases).columns.find((column) => column.name === "memory_id")?.getSQLType()).toBe("uuid");
  });
});
