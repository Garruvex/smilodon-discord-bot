import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, vector } from "drizzle-orm/pg-core";

// Fixed at schema-definition time — pgvector columns can't have a variable
// dimension. Matches OpenAI's text-embedding-3-small, the default/most
// common embedding model for this app (see CHAT_EMBEDDING_MODEL). Switching
// to a model with a different output size requires a follow-up migration.
export const embeddingDimensions = 1536;

export const guildConfigurations = pgTable("guild_configurations", {
  guildId: text("guild_id").primaryKey(),
  configuration: jsonb("configuration").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const controlPanels = pgTable("control_panels", {
  guildId: text("guild_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Hub entity for "this Discord member in this guild." Existing guildId/userId
// columns on the tables below are left as the source of truth for reads —
// memberId is additive, populated on writes via GuildMemberRegistry, and
// exists only to give ON DELETE CASCADE something to cascade from and to
// provide a join point for future per-member features.
export const guildMembers = pgTable("guild_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("guild_members_guild_user").on(table.guildId, table.userId),
]);

// Recent-exchange transcript, scoped per channel so a user's short-term
// "what did we just say" history doesn't bleed across channels (e.g.
// #general chatter leaking into a DND channel's scene continuity, or vice
// versa). dmNotesEnabled lives separately in dmNotesPreferences — it's a
// per-user preference, not per-channel, and can't live on a row keyed by
// channel.
export const chatSessions = pgTable("chat_sessions", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  channelId: text("channel_id").notNull(),
  memberId: uuid("member_id").references(() => guildMembers.id, { onDelete: "cascade" }),
  exchanges: jsonb("exchanges").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.userId, table.channelId] })]);

// Per-user, per-guild preference for whether mention-chat system notes are
// DMed to them — split out of chat_sessions once that table became
// per-channel (a preference isn't scoped to any one channel).
export const dmNotesPreferences = pgTable("dm_notes_preferences", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  memberId: uuid("member_id").references(() => guildMembers.id, { onDelete: "cascade" }),
  dmNotesEnabled: boolean("dm_notes_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.userId] })]);

export const chatMemories = pgTable("chat_memories", {
  id: uuid("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  assertedByUserId: text("asserted_by_user_id").notNull(),
  // References the asserter (assertedByUserId), not subjectUserId — the
  // asserter is the row's real owner (eviction/limits are scoped to them).
  // subjectUserId stays a plain unconstrained column so a memory can
  // reference someone mentioned in conversation without requiring them to
  // already have a member row.
  memberId: uuid("member_id").references(() => guildMembers.id, { onDelete: "cascade" }),
  subjectUserId: text("subject_user_id").notNull(),
  topic: text("topic").notNull(),
  slot: text("slot").notNull(),
  statement: text("statement").notNull(),
  // Native pgvector storage — HNSW-indexed below for cosine-distance nearest-
  // neighbor queries. Null until vector recall is enabled and/or this record
  // is re-embedded.
  embedding: vector("embedding", { dimensions: embeddingDimensions }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("chat_memories_owner_subject_topic_slot").on(
    table.guildId, table.assertedByUserId, table.subjectUserId, table.topic, table.slot,
  ),
  index("chat_memories_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
]);

export const userCustomizations = pgTable("user_customizations", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  memberId: uuid("member_id").references(() => guildMembers.id, { onDelete: "cascade" }),
  customization: text("customization").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.userId] })]);

export const birthdays = pgTable("birthdays", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  memberId: uuid("member_id").references(() => guildMembers.id, { onDelete: "cascade" }),
  month: integer("month").notNull(),
  day: integer("day").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.userId] })]);

export const birthdayAnnouncements = pgTable("birthday_announcements", {
  guildId: text("guild_id").notNull(),
  date: text("date").notNull(),
  announcedAt: timestamp("announced_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.date] })]);

export const guildKnowledge = pgTable("guild_knowledge", {
  id: uuid("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  // Null = guild-wide fact, visible from every channel. Set = scoped to one
  // channel/scene — only surfaced when that channel is the current one (see
  // PostgresGuildKnowledgeStore.loadConfirmed). Part of the identity index
  // below so a channel-scoped fact and a guild-wide fact can coexist under
  // the same (subjectType, subjectId, topic, slot).
  channelId: text("channel_id"),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  topic: text("topic").notNull(),
  slot: text("slot").notNull(),
  statement: text("statement").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  assertedByUserIds: jsonb("asserted_by_user_ids").notNull().default([]),
  confirmedByUserIds: jsonb("confirmed_by_user_ids").notNull().default([]),
  // Native pgvector storage — HNSW-indexed below for cosine-distance nearest-
  // neighbor queries. Null until vector recall is enabled and/or this record
  // is re-embedded.
  embedding: vector("embedding", { dimensions: embeddingDimensions }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("guild_knowledge_subject_topic_slot").on(
    table.guildId, table.channelId, table.subjectType, table.subjectId, table.topic, table.slot,
  ),
  index("guild_knowledge_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
]);
