import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Local (dev-only) backend equivalent of schema.ts's Postgres tables, for
// exactly the two chat/knowledge stores that need it (SqliteChatStateStore/
// SqliteGuildKnowledgeStore — see persistence-factory.ts; everything else on
// the local backend stays JSON/YAML). No memberId/guildMembers hub table —
// that's a Postgres-only concept the local backend already omits.
// jsonb columns become text(..., { mode: "json" }); uuid PKs become plain
// text (crypto.randomUUID() generated app-side, same as before); timestamps
// use integer(..., { mode: "timestamp_ms" }), which drizzle maps to/from a
// JS Date, matching the Postgres stores' `.getTime()` usage.

export const chatSessions = sqliteTable("chat_sessions", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  channelId: text("channel_id").notNull(),
  exchanges: text("exchanges", { mode: "json" }).notNull().default([]),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.userId, table.channelId] })]);

export const dmNotesPreferences = sqliteTable("dm_notes_preferences", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  dmNotesEnabled: integer("dm_notes_enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.userId] })]);

export const chatMemories = sqliteTable("chat_memories", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  assertedByUserId: text("asserted_by_user_id").notNull(),
  subjectUserId: text("subject_user_id").notNull(),
  topic: text("topic").notNull(),
  slot: text("slot").notNull(),
  statement: text("statement").notNull(),
  embedding: text("embedding", { mode: "json" }).$type<number[] | null>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("chat_memories_owner_subject_topic_slot").on(
    table.guildId, table.assertedByUserId, table.subjectUserId, table.topic, table.slot,
  ),
]);

// Central memory model (Plan 1) — mirrors schema.ts's `memories`/
// `memory_sources`. `embedding` is stored as JSON text (no native vector
// column); recall does a SQL-filtered scan followed by an application-side
// cosine pass — see MemoryEngine's SQLite ceiling handling.
export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  kind: text("kind").notNull(),
  audience: text("audience").notNull(),
  ownerUserId: text("owner_user_id"),
  channelId: text("channel_id"),
  isolationChannelId: text("isolation_channel_id"),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  topic: text("topic").notNull(),
  slot: text("slot").notNull(),
  statement: text("statement").notNull(),
  structuredValue: text("structured_value", { mode: "json" }).$type<unknown>(),
  status: text("status").notNull(),
  supersededById: text("superseded_by_id"),
  source: text("source").notNull(),
  confidence: integer("confidence").notNull(),
  importance: integer("importance").notNull(),
  embedding: text("embedding", { mode: "json" }).$type<number[] | null>(),
  embeddingModel: text("embedding_model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
}, (table) => [
  // Partial (status = 'active' only) — see schema.ts's memories table for why.
  uniqueIndex("memories_identity").on(
    table.guildId, table.ownerUserId, table.channelId, table.isolationChannelId,
    table.subjectType, table.subjectId, table.topic, table.slot,
  ).where(sql`${table.status} = 'active'`),
]);

export const memorySources = sqliteTable("memory_sources", {
  id: text("id").primaryKey(),
  memoryId: text("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  sourceMessageId: text("source_message_id"),
  sourceChannelId: text("source_channel_id"),
  assertedByUserId: text("asserted_by_user_id"),
  statement: text("statement").notNull(),
  source: text("source").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const guildKnowledge = sqliteTable("guild_knowledge", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id"),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  topic: text("topic").notNull(),
  slot: text("slot").notNull(),
  statement: text("statement").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  assertedByUserIds: text("asserted_by_user_ids", { mode: "json" }).notNull().default([]),
  confirmedByUserIds: text("confirmed_by_user_ids", { mode: "json" }).notNull().default([]),
  embedding: text("embedding", { mode: "json" }).$type<number[] | null>(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("guild_knowledge_subject_topic_slot").on(
    table.guildId, table.channelId, table.subjectType, table.subjectId, table.topic, table.slot,
  ),
]);
