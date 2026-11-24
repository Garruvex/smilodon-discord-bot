import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "../../src/infrastructure/database/sqlite-schema.js";
import { SqliteMessageOriginStore } from "../../src/infrastructure/persistence/sqlite-message-origin-store.js";
import { SqliteMessageRevocationStore } from "../../src/infrastructure/persistence/sqlite-message-revocation-store.js";
import { expectV1ReadsAfterMigration, migrationsBeforeLatest, populateV1, revisionRow } from "./provenance-schema-contract.js";

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });

describe("provenance graph schema (sqlite)", () => {
  it("migrates a populated v1 database, keeps v1 reads and gives each output revision its own identity", async () => {
    const client = new Database(join(mkdtempSync(join(tmpdir(), "provenance-schema-")), "chat.sqlite")); close.push(() => client.close());
    const database = drizzle(client, { schema });
    const { previous, latestTag } = migrationsBeforeLatest(resolve("drizzle-sqlite"));
    migrate(database, { migrationsFolder: previous });
    expect(client.prepare("SELECT name FROM sqlite_master WHERE name = 'provenance_revisions'").all()).toEqual([]);
    await populateV1((statement) => { client.exec(statement); return Promise.resolve(); }, "sqlite");

    migrate(database, { migrationsFolder: resolve("drizzle-sqlite") });
    expect(latestTag).toMatch(/^0018_/u);
    const revocations = new SqliteMessageRevocationStore(database); const origins = new SqliteMessageOriginStore(database);
    await expectV1ReadsAfterMigration(revocations, origins);

    // Two revisions of the same output are distinct rows; the same version twice is refused.
    database.insert(schema.provenanceRevisions).values([revisionRow("r1", 1, 1), revisionRow("r2", 2, 2)]).run();
    expect(() => database.insert(schema.provenanceRevisions).values(revisionRow("r3", 2, 3)).run()).toThrow(/UNIQUE/u);
    // Ordinals are unique within a scope.
    expect(() => database.insert(schema.provenanceRevisions).values({ ...revisionRow("r4", 3, 2) }).run()).toThrow(/UNIQUE/u);
    database.insert(schema.provenanceRevisions).values({ ...revisionRow("other", 1, 1), channelId: "other" }).run();
    database.insert(schema.provenanceCurrent).values({ guildId: "guild", channelId: "channel", kind: "reply_part", artifactId: "reply", revisionId: "r2", version: 2 }).run();
    // Edges are unique per child, parent and projection, and readable from either end.
    database.insert(schema.provenanceEdges).values([{ childId: "r2", parentId: "r1", projection: "full", representationHash: "a".repeat(64) },
      { childId: "r2", parentId: "r1", projection: "human_text:1000", representationHash: "b".repeat(64) }]).run();
    expect(() => database.insert(schema.provenanceEdges).values({ childId: "r2", parentId: "r1", projection: "full", representationHash: "c".repeat(64) }).run()).toThrow(/UNIQUE/u);
    expect(database.select().from(schema.provenanceEdges).where(eq(schema.provenanceEdges.parentId, "r1")).all()).toHaveLength(2);
    expect(database.select().from(schema.provenanceCurrent).all()).toEqual([expect.objectContaining({ revisionId: "r2", version: 2 })]);
    const plan = client.prepare("EXPLAIN QUERY PLAN SELECT child_id FROM provenance_edges WHERE parent_id = ?").all("r1");
    expect(JSON.stringify(plan)).toContain("provenance_edges_parent_idx");
  });
});
