import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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

export const chatSessions = pgTable("chat_sessions", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  exchanges: jsonb("exchanges").notNull().default([]),
  dmNotesEnabled: boolean("dm_notes_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.userId] })]);

export const chatMemories = pgTable("chat_memories", {
  id: uuid("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  assertedByUserId: text("asserted_by_user_id").notNull(),
  subjectUserId: text("subject_user_id").notNull(),
  topic: text("topic").notNull(),
  slot: text("slot").notNull(),
  statement: text("statement").notNull(),
  pinned: boolean("pinned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("chat_memories_owner_subject_topic_slot").on(
    table.guildId, table.assertedByUserId, table.subjectUserId, table.topic, table.slot,
  ),
]);

export const userCustomizations = pgTable("user_customizations", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  customization: text("customization").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.userId] })]);

export const birthdays = pgTable("birthdays", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
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
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  topic: text("topic").notNull(),
  slot: text("slot").notNull(),
  statement: text("statement").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  assertedByUserIds: jsonb("asserted_by_user_ids").notNull().default([]),
  confirmedByUserIds: jsonb("confirmed_by_user_ids").notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("guild_knowledge_subject_topic_slot").on(
    table.guildId, table.subjectType, table.subjectId, table.topic, table.slot,
  ),
]);
