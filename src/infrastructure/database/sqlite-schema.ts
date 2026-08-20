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
