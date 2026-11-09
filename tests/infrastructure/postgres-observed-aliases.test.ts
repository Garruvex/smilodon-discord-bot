import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDatabaseConnection } from "../../src/infrastructure/database/database.js";
import { PostgresMemoryRepository } from "../../src/infrastructure/persistence/postgres-memory-repository.js";

const databaseUrl = process.env.POSTGRES_MIGRATION_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgreSQL observed aliases", () => {
  it("encodes the expiry timestamp and filters aliases by visibility and ownership", async () => {
    const schemaName = `alias_lookup_${randomUUID().replaceAll("-", "")}`;
    const connection = await createDatabaseConnection(databaseUrl!, schemaName);
    const repository = new PostgresMemoryRepository(connection.database);
    const now = Date.UTC(2026, 9, 15);
    try {
      // The lookup needs no vector columns, so exercise the real driver on plain PostgreSQL.
      await connection.database.execute(sql.raw(`CREATE TABLE memories (
        id uuid PRIMARY KEY, guild_id text, subject_id text, subject_type text DEFAULT 'member',
        status text DEFAULT 'active', module_id text, expires_at timestamptz,
        isolation_channel_id text, audience text, channel_id text, owner_user_id text);
        CREATE TABLE memory_observed_aliases (guild_id text, alias text, memory_id uuid REFERENCES memories(id));`));
      const fixtures = [
        { subject: "guild", audience: "guild" },
        { subject: "future", audience: "guild", expires: now + 1 },
        { subject: "expired", audience: "guild", expires: now },
        { subject: "channel", audience: "channel", channel: "channel" },
        { subject: "other-channel", audience: "channel", channel: "other" },
        { subject: "private", audience: "private", owner: "user" },
        { subject: "other-private", audience: "private", owner: "other" },
        { subject: "isolated", audience: "guild", isolation: "other" },
        { subject: "local", audience: "guild", isolation: "channel" },
        { subject: "module", audience: "guild", module: "relationships" },
        { subject: "inactive", audience: "guild", status: "superseded" },
        { subject: "persona", audience: "guild", type: "persona" },
        { subject: "other-guild", audience: "guild", guild: "other" },
      ];
      for (const fixture of fixtures) {
        const id = randomUUID();
        await connection.database.execute(sql`INSERT INTO memories
          (id, guild_id, subject_id, subject_type, status, module_id, expires_at,
           isolation_channel_id, audience, channel_id, owner_user_id)
          VALUES (${id}::uuid, ${fixture.guild ?? "guild"}, ${fixture.subject}, ${fixture.type ?? "member"},
            ${fixture.status ?? "active"}, ${fixture.module ?? null},
            ${fixture.expires === undefined ? null : new Date(fixture.expires).toISOString()}::timestamptz,
            ${fixture.isolation ?? null}, ${fixture.audience}, ${fixture.channel ?? null}, ${fixture.owner ?? null})`);
        await connection.database.execute(sql`INSERT INTO memory_observed_aliases
          VALUES (${fixture.guild ?? "guild"}, 'alice', ${id}::uuid)`);
      }
      const query = { guildId: "guild", channelId: "channel", userId: "user", now, message: "Alice" };
      const aliases = await repository.findObservedAliases(query);
      expect(aliases.map((alias) => alias.subjectId).sort()).toEqual(["channel", "future", "guild", "local", "private"]);
      expect(aliases.every((alias) => alias.alias === "alice")).toBe(true);
      expect((await repository.findObservedAliases({ ...query, now: now + 1 })).map((alias) => alias.subjectId).sort())
        .toEqual(["channel", "guild", "local", "private"]);
    } finally {
      await connection.database.execute(sql`DROP SCHEMA ${sql.identifier(schemaName)} CASCADE`);
      await connection.close();
    }
  }, 30_000);
});
