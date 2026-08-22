// One-time backfill: chat_memories + guild_knowledge -> memories +
// memory_sources (Plan 1's central memory schema). Safe to re-run — the
// legacy row's own id is reused as the new memories.id, so a rerun skips
// rows already migrated (primary-key conflict) rather than duplicating
// them. Legacy tables are left untouched; nothing here deletes from them.
//
// Usage: npx tsx src/scripts/migrate-memories-to-central-schema.ts
// (reads the same environment as the running bot — PERSISTENCE_DRIVER,
// DATABASE_URL/RUNTIME_DATA_DIRECTORY, INSTANCE_NAME for Postgres.)
import { pathToFileURL } from "node:url";

import { and, eq } from "drizzle-orm";

import { loadConfiguration } from "../config/environment.js";
import { createDatabaseConnection, resolveInstanceSchemaName } from "../infrastructure/database/database.js";
import { createSqliteDatabaseConnection } from "../infrastructure/database/sqlite-database.js";
import * as pgSchema from "../infrastructure/database/schema.js";
import * as sqliteSchema from "../infrastructure/database/sqlite-schema.js";

function deriveKind(topic: string): "fact" | "preference" | "episode" {
  if (topic === "scene_summary") return "episode";
  if (topic === "preference") return "preference";
  return "fact";
}

// guild_knowledge has no equivalent of "expired" — "deprecated" is the
// closest legacy status but isn't quite the same concept (deliberately
// dropped rather than time-expired). Mapped to "expired" with an
// already-past expiresAt so it's excluded from recall going forward,
// documented here rather than silently reinterpreted.
function mapGuildKnowledgeStatus(status: string, now: number): { status: "active" | "candidate" | "expired"; expiresAt: Date | null } {
  if (status === "confirmed") return { status: "active", expiresAt: null };
  if (status === "deprecated") return { status: "expired", expiresAt: new Date(now) };
  return { status: "candidate", expiresAt: null };
}

export async function migratePostgres(databaseUrl: string, instanceName: string): Promise<void> {
  const connection = await createDatabaseConnection(databaseUrl, resolveInstanceSchemaName(instanceName));
  const db = connection.database;
  const now = Date.now();
  let migratedMemories = 0, migratedSources = 0;

  const memories = await db.select().from(pgSchema.chatMemories);
  for (const row of memories) {
    const inserted = await db.insert(pgSchema.memories).values({
      id: row.id, guildId: row.guildId, kind: deriveKind(row.topic), audience: "private",
      ownerUserId: row.assertedByUserId, channelId: null, isolationChannelId: null,
      subjectType: "member", subjectId: row.subjectUserId, topic: row.topic, slot: row.slot,
      statement: row.statement, status: "active", source: "live", confidence: 1, importance: 1,
      embedding: row.embedding, embeddingModel: row.embedding ? "legacy" : null,
      createdAt: row.createdAt, updatedAt: row.updatedAt, expiresAt: null, validFrom: row.createdAt, validUntil: null,
    }).onConflictDoNothing({ target: pgSchema.memories.id }).returning({ id: pgSchema.memories.id });
    if (inserted.length === 0) continue;
    migratedMemories++;
    const existingSource = await db.select().from(pgSchema.memorySources)
      .where(and(eq(pgSchema.memorySources.memoryId, row.id), eq(pgSchema.memorySources.source, "live"))).limit(1);
    if (existingSource.length === 0) {
      await db.insert(pgSchema.memorySources).values({
        id: crypto.randomUUID(), memoryId: row.id, sourceMessageId: null, sourceChannelId: null,
        assertedByUserId: row.assertedByUserId, statement: row.statement, source: "live", createdAt: row.createdAt,
      });
      migratedSources++;
    }
  }

  const knowledge = await db.select().from(pgSchema.guildKnowledge);
  for (const row of knowledge) {
    const { status, expiresAt } = mapGuildKnowledgeStatus(row.status, now);
    const inserted = await db.insert(pgSchema.memories).values({
      id: row.id, guildId: row.guildId, kind: deriveKind(row.topic),
      audience: row.channelId === null ? "guild" : "channel",
      ownerUserId: null, channelId: row.channelId, isolationChannelId: null,
      subjectType: row.subjectType, subjectId: row.subjectId, topic: row.topic, slot: row.slot,
      statement: row.statement, status, source: row.source === "self_report" ? "explicit"
        : row.source === "consolidation" ? "consolidation" : row.source === "administrator" ? "administrator" : "live",
      confidence: 1, importance: 1, embedding: row.embedding, embeddingModel: row.embedding ? "legacy" : null,
      createdAt: row.createdAt, updatedAt: row.updatedAt, expiresAt: expiresAt ?? row.expiresAt, validFrom: row.createdAt, validUntil: null,
    }).onConflictDoNothing({ target: pgSchema.memories.id }).returning({ id: pgSchema.memories.id });
    if (inserted.length === 0) continue;
    migratedMemories++;
    const assertedBy = Array.isArray(row.assertedByUserIds) ? row.assertedByUserIds as string[] : [];
    for (const userId of assertedBy) {
      await db.insert(pgSchema.memorySources).values({
        id: crypto.randomUUID(), memoryId: row.id, sourceMessageId: null, sourceChannelId: row.channelId,
        assertedByUserId: userId, statement: row.statement, source: "live", createdAt: row.createdAt,
      });
      migratedSources++;
    }
    if (assertedBy.length === 0) {
      await db.insert(pgSchema.memorySources).values({
        id: crypto.randomUUID(), memoryId: row.id, sourceMessageId: null, sourceChannelId: row.channelId,
        assertedByUserId: null, statement: row.statement, source: "consolidation", createdAt: row.createdAt,
      });
      migratedSources++;
    }
  }

  console.log(`Postgres: migrated ${migratedMemories} memories, ${migratedSources} sources (chat_memories: ${memories.length}, guild_knowledge: ${knowledge.length}).`);
  await connection.close();
}

export function migrateSqlite(runtimeDataDirectory: string): void {
  const connection = createSqliteDatabaseConnection(runtimeDataDirectory);
  const db = connection.database;
  const now = Date.now();
  let migratedMemories = 0, migratedSources = 0;

  const memories = db.select().from(sqliteSchema.chatMemories).all();
  for (const row of memories) {
    const existing = db.select().from(sqliteSchema.memories).where(eq(sqliteSchema.memories.id, row.id)).get();
    if (existing) continue;
    db.insert(sqliteSchema.memories).values({
      id: row.id, guildId: row.guildId, kind: deriveKind(row.topic), audience: "private",
      ownerUserId: row.assertedByUserId, channelId: null, isolationChannelId: null,
      subjectType: "member", subjectId: row.subjectUserId, topic: row.topic, slot: row.slot,
      statement: row.statement, status: "active", source: "live", confidence: 1, importance: 1,
      embedding: row.embedding, embeddingModel: row.embedding ? "legacy" : null,
      createdAt: row.createdAt, updatedAt: row.updatedAt, expiresAt: null, validFrom: row.createdAt, validUntil: null,
    }).run();
    db.insert(sqliteSchema.memorySources).values({
      id: crypto.randomUUID(), memoryId: row.id, sourceMessageId: null, sourceChannelId: null,
      assertedByUserId: row.assertedByUserId, statement: row.statement, source: "live", createdAt: row.createdAt,
    }).run();
    migratedMemories++;
    migratedSources++;
  }

  const knowledge = db.select().from(sqliteSchema.guildKnowledge).all();
  for (const row of knowledge) {
    const existing = db.select().from(sqliteSchema.memories).where(eq(sqliteSchema.memories.id, row.id)).get();
    if (existing) continue;
    const { status, expiresAt } = mapGuildKnowledgeStatus(row.status, now);
    db.insert(sqliteSchema.memories).values({
      id: row.id, guildId: row.guildId, kind: deriveKind(row.topic),
      audience: row.channelId === null ? "guild" : "channel",
      ownerUserId: null, channelId: row.channelId, isolationChannelId: null,
      subjectType: row.subjectType, subjectId: row.subjectId, topic: row.topic, slot: row.slot,
      statement: row.statement, status, source: row.source === "self_report" ? "explicit"
        : row.source === "consolidation" ? "consolidation" : row.source === "administrator" ? "administrator" : "live",
      confidence: 1, importance: 1, embedding: row.embedding, embeddingModel: row.embedding ? "legacy" : null,
      createdAt: row.createdAt, updatedAt: row.updatedAt, expiresAt: expiresAt ?? row.expiresAt, validFrom: row.createdAt, validUntil: null,
    }).run();
    migratedMemories++;
    const assertedBy = Array.isArray(row.assertedByUserIds) ? row.assertedByUserIds as string[] : [];
    for (const userId of assertedBy) {
      db.insert(sqliteSchema.memorySources).values({
        id: crypto.randomUUID(), memoryId: row.id, sourceMessageId: null, sourceChannelId: row.channelId,
        assertedByUserId: userId, statement: row.statement, source: "live", createdAt: row.createdAt,
      }).run();
      migratedSources++;
    }
    if (assertedBy.length === 0) {
      db.insert(sqliteSchema.memorySources).values({
        id: crypto.randomUUID(), memoryId: row.id, sourceMessageId: null, sourceChannelId: row.channelId,
        assertedByUserId: null, statement: row.statement, source: "consolidation", createdAt: row.createdAt,
      }).run();
      migratedSources++;
    }
  }

  console.log(`SQLite: migrated ${migratedMemories} memories, ${migratedSources} sources (chat_memories: ${memories.length}, guild_knowledge: ${knowledge.length}).`);
  connection.close();
}

// Guarded so importing this module for its exported functions (e.g. from a
// test/verification script) doesn't also trigger loadConfiguration() and a
// live migration — only running this file directly does.
const isMainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const configuration = loadConfiguration();
  if (configuration.persistence.driver === "postgres") {
    if (!configuration.persistence.databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL persistence.");
    if (!configuration.instanceName) throw new Error("INSTANCE_NAME is required for PostgreSQL schema isolation.");
    await migratePostgres(configuration.persistence.databaseUrl, configuration.instanceName);
  } else {
    migrateSqlite(configuration.runtimeDataDirectory);
  }
}
