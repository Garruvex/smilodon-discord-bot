import { sql } from "drizzle-orm";
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

// Central memory model (Plan 1) — supersedes chatMemories/guildKnowledge.
// audience answers "who's normally allowed to read this"; isolationChannelId
// answers "is this forbidden from leaving one channel, regardless of
// audience" — the two compose independently (see MemoryEngine.canRecall).
// Legacy tables above stay in place, unused, until migration is verified.
export const memories = pgTable("memories", {
  id: uuid("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  // Content shape only ("fact" | "preference" | "episode") — independent of
  // who can see it. Never encodes audience (no "guild_fact"/"channel_episode").
  kind: text("kind").notNull(),
  audience: text("audience").notNull(), // "private" | "channel" | "guild"
  ownerUserId: text("owner_user_id"),
  channelId: text("channel_id"),
  isolationChannelId: text("isolation_channel_id"),
  subjectType: text("subject_type").notNull(), // "member" | "guild" | "team" | "project"
  subjectId: text("subject_id").notNull(),
  topic: text("topic").notNull(),
  slot: text("slot").notNull(),
  statement: text("statement").notNull(),
  structuredValue: jsonb("structured_value"),
  status: text("status").notNull(), // "candidate" | "active" | "superseded" | "expired"
  supersededById: uuid("superseded_by_id"),
  source: text("source").notNull(), // "live" | "explicit" | "administrator" | "consolidation"
  confidence: integer("confidence").notNull(),
  importance: integer("importance").notNull(),
  embedding: vector("embedding", { dimensions: embeddingDimensions }),
  embeddingModel: text("embedding_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // Bi-temporal history (Zep-style): the interval during which this row was
  // the current value for its identity. validFrom defaults to createdAt.
  // validUntil is null while the row is current — set once, at the moment a
  // replacement row is inserted for the same identity (see
  // PostgresMemoryRepository.ingest), never mutated again. Distinct from
  // status: an "active" row is also the current row (validUntil null); a
  // "superseded" row keeps its validUntil timestamp permanently as the
  // historical record of when it stopped being true.
  validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
  validUntil: timestamp("valid_until", { withTimezone: true }),
}, (table) => [
  // Includes isolationChannelId: a member's public preference and their
  // isolated-channel (e.g. D&D character) preference under the same
  // subject/topic/slot are legitimately different rows. Partial (status =
  // 'active' only) so conflicting claims can coexist as separate 'candidate'
  // rows under the same identity instead of colliding — see canRecall/
  // the plan's contradictory-claims fix. Only one *active* memory per
  // identity is enforced at the database level.
  uniqueIndex("memories_identity").on(
    table.guildId, table.ownerUserId, table.channelId, table.isolationChannelId,
    table.subjectType, table.subjectId, table.topic, table.slot,
  ).where(sql`${table.status} = 'active'`),
  index("memories_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
  index("memories_guild_audience_status").on(table.guildId, table.audience, table.status),
]);

export const memorySources = pgTable("memory_sources", {
  id: uuid("id").primaryKey(),
  memoryId: uuid("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  sourceMessageId: text("source_message_id"),
  sourceChannelId: text("source_channel_id"),
  assertedByUserId: text("asserted_by_user_id"),
  // What THIS source actually claimed — may differ from the canonical
  // memory's statement once dedup/consolidation has merged multiple sources.
  statement: text("statement").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("memory_sources_memory_id").on(table.memoryId),
]);

// Plan 2 (channel context) — drives both the one-time scan
// (contextScanChannelIds, via lastMessageId as a resumable cursor) and the
// daily consolidation (contextDailyChannelIds, via lastRunAt as an
// once-per-day gate). See channel-summary-scheduler.ts.
export const channelSummaryCheckpoints = pgTable("channel_summary_checkpoints", {
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  // Scan's resumability cursor — null means the scan has never run for this
  // channel; non-null with scanCompletedAt still null means a capped run
  // stopped partway and should resume from here next tick. Not used by the
  // daily path.
  lastMessageId: text("last_message_id"),
  // Set once the scan reaches the seed-day boundary (or the channel's
  // start) without hitting the per-tick cap — the channel is then never
  // scheduled again by the scan path, regardless of lastMessageId.
  scanCompletedAt: timestamp("scan_completed_at", { withTimezone: true }),
  // Daily's in-progress resume cursor — non-null means a capped daily batch
  // stopped partway and should resume `before` this id next tick, instead of
  // re-fetching from the newest message.
  dailyCursor: text("daily_cursor"),
  // Lower boundary for the next daily cycle — null means "use now - 24h".
  // Advances to the completion tick's timestamp once a cycle fully reaches
  // its boundary, so downtime longer than a day (or a multi-tick capped
  // run) never silently loses messages between cycles.
  dailyHighWaterMarkAt: timestamp("daily_high_water_mark_at", { withTimezone: true }),
  // Daily's "have I already run today" gate — null means never run.
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  // Surfaced by /settings chat context-status; cleared on next success.
  lastError: text("last_error"),
  lastErrorCode: text("last_error_code"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.guildId, table.channelId] }),
]);

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
