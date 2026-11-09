import { describe, expect, it } from "vitest";
import { normalizeSqliteMigration } from "../../src/infrastructure/database/sqlite-migration-normalization.js";

describe("SQLite migration expression normalization", () => {
  it("repairs generated coalesce expressions without rewriting valid indexes", () => {
    const generated = 'CREATE UNIQUE INDEX `test` ON `table` (`guild_id`,`coalesce("channel_id"`,` \'\')`);';
    const expected = "CREATE UNIQUE INDEX `test` ON `table` (`guild_id`,coalesce(`channel_id`, ''));";
    expect(normalizeSqliteMigration(generated)).toBe(expected);
    expect(normalizeSqliteMigration(expected)).toBe(expected);
  });
});
