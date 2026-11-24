import type { ContextProvenance } from "../../application/chat/context-provenance.js";
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { MessageOrigin } from "../../application/chat/message-origin-store.js";
import type { MessageCleanupState } from "../../application/chat/message-revocation-store.js";
import type { ProvenanceCompleteness, ProvenanceLineage, ProvenanceRevisionKind, ProvenanceRevisionState } from "../../application/provenance/provenance-graph.js";
import type { ChannelHistoryMessage } from "../../application/chat/chat-provider.js";

export const memoryObservedAliases = sqliteTable("memory_observed_aliases", {
  guildId: text("guild_id").notNull(),
  alias: text("alias").notNull(),
  memoryId: text("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.memoryId, table.alias] }), index("memory_observed_aliases_lookup").on(table.guildId, table.alias)]);

export const conversationEpisodes = sqliteTable("conversation_episodes", {
  retentionMs: integer("retention_ms").notNull().default(900_000),
  guildId: text("guild_id").notNull(), channelId: text("channel_id").notNull(),
  events: text("events", { mode: "json" }).$type<ChannelHistoryMessage[]>().notNull().default([]),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.channelId] })]);

export const messageOrigins = sqliteTable("message_origins", {
  messageId: text("message_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  origin: text("origin").$type<MessageOrigin>().notNull(),
  sourceMessageId: text("source_message_id"),
  contextProvenance: text("context_provenance", { mode: "json" }).$type<ContextProvenance>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("message_origins_scope_idx").on(table.guildId, table.channelId)]);

export const memoryForgetCutoffs = sqliteTable("memory_forget_cutoffs", {
  guildId: text("guild_id").notNull(), subjectId: text("subject_id").notNull(),
  topic: text("topic").notNull(), slot: text("slot").notNull(), scopeKey: text("scope_key").notNull(),
  cutoff: integer("cutoff", { mode: "timestamp_ms" }).notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.subjectId, table.topic, table.slot, table.scopeKey] })]);

// Discord deletes the guild honours, keyed without author so bot messages and author-less events are covered.
// Each channel's revision only increases; revocations in one channel take its scope row lock in order.
export const messageRevocations = sqliteTable("message_revocations", {
  guildId: text("guild_id").notNull(), channelId: text("channel_id").notNull(), messageId: text("message_id").notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }).notNull(),
  revision: integer("revision").notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.channelId, table.messageId] })]);

export const messageRevocationScopes = sqliteTable("message_revocation_scopes", {
  guildId: text("guild_id").notNull(), channelId: text("channel_id").notNull(),
  revision: integer("revision").notNull(),
  // Last provenance ordinal handed out in this scope; see provenanceRevisions.
  ordinal: integer("ordinal").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.guildId, table.channelId] })]);

// Physical cleanup for a revocation, committed with it. state is pending, claimed or done; nextAt is when
// pending work becomes due or when a claimed lease expires.
export const messageCleanupWork = sqliteTable("message_cleanup_work", {
  guildId: text("guild_id").notNull(), channelId: text("channel_id").notNull(), messageId: text("message_id").notNull(),
  state: text("state").$type<MessageCleanupState>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAt: integer("next_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.channelId, table.messageId] }), index("message_cleanup_work_due_idx").on(table.state, table.nextAt)]);

// Shadow provenance graph (see application/provenance/provenance-graph.ts). Revisions are immutable once
// published. ordinal increases within a scope and every parent's is smaller than its child's, which keeps
// the graph acyclic; it comes from message_revocation_scopes.ordinal, so publication takes the same
// scope row as revocation. Roles (author, subject, owner, asserter) are indexed apart from each other.
export const provenanceRevisions = sqliteTable("provenance_revisions", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(), channelId: text("channel_id").notNull(),
  kind: text("kind").$type<ProvenanceRevisionKind>().notNull(), artifactId: text("artifact_id").notNull(),
  version: integer("version").notNull(), ordinal: integer("ordinal").notNull(),
  state: text("state").$type<ProvenanceRevisionState>().notNull(),
  completeness: text("completeness").$type<ProvenanceCompleteness>().notNull(),
  purpose: text("purpose"), audienceUserId: text("audience_user_id"),
  outputHash: text("output_hash"), attachmentHash: text("attachment_hash"),
  // A message's Discord author and time and the hash of the representation this revision stands for.
  authorId: text("author_id"), sourceTimestampMs: integer("source_timestamp_ms"), representationHash: text("representation_hash"),
  subjectId: text("subject_id"), ownerId: text("owner_id"), asserterId: text("asserter_id"),
  lineage: text("lineage", { mode: "json" }).$type<ProvenanceLineage>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("provenance_revisions_version_idx").on(table.guildId, table.channelId, table.kind, table.artifactId, table.version),
  uniqueIndex("provenance_revisions_ordinal_idx").on(table.guildId, table.channelId, table.ordinal),
  index("provenance_revisions_author_idx").on(table.guildId, table.authorId),
  index("provenance_revisions_subject_idx").on(table.guildId, table.subjectId),
  index("provenance_revisions_owner_idx").on(table.guildId, table.ownerId),
  index("provenance_revisions_asserter_idx").on(table.guildId, table.asserterId),
]);

// Which revision of an artifact is current. Moves only forward, in the transaction that publishes it.
export const provenanceCurrent = sqliteTable("provenance_current", {
  guildId: text("guild_id").notNull(), channelId: text("channel_id").notNull(),
  kind: text("kind").$type<ProvenanceRevisionKind>().notNull(), artifactId: text("artifact_id").notNull(),
  revisionId: text("revision_id").notNull().references(() => provenanceRevisions.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.channelId, table.kind, table.artifactId] })]);

// A parent revision supplied, in a pinned projection, when the child was produced. One row per
// child, parent and projection; indexed both ways for forward reads and reverse cleanup.
export const provenanceEdges = sqliteTable("provenance_edges", {
  childId: text("child_id").notNull().references(() => provenanceRevisions.id, { onDelete: "cascade" }),
  parentId: text("parent_id").notNull().references(() => provenanceRevisions.id, { onDelete: "cascade" }),
  // kind plus character limit, e.g. "full" or "human_text:1000".
  projection: text("projection").notNull(),
  representationHash: text("representation_hash").notNull(), assetsHash: text("assets_hash"),
}, (table) => [primaryKey({ columns: [table.childId, table.parentId, table.projection] }), index("provenance_edges_parent_idx").on(table.parentId, table.childId)]);

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
  contextProvenance: text("context_provenance", { mode: "json" }).$type<ContextProvenance>(),
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  moduleId: text("module_id"),
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
  importance: integer("importance").notNull(),
  embedding: text("embedding", { mode: "json" }).$type<number[] | null>(),
  embeddingModel: text("embedding_model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  // See schema.ts's memories table for the bi-temporal rationale.
  validFrom: integer("valid_from", { mode: "timestamp_ms" }).notNull(),
  validUntil: integer("valid_until", { mode: "timestamp_ms" }),
}, (table) => [
  // Partial (status = 'active' only), nullable columns COALESCEd — see
  // schema.ts's memories table for why.
  uniqueIndex("memories_identity").on(
    table.guildId, sql`coalesce(${table.ownerUserId}, '')`, sql`coalesce(${table.channelId}, '')`,
    sql`coalesce(${table.isolationChannelId}, '')`,
    sql`coalesce(${table.moduleId}, '')`,
    table.subjectType, table.subjectId, table.topic, table.slot,
  ).where(sql`${table.status} = 'active'`),
]);

export const memorySources = sqliteTable("memory_sources", {
  sourceTimestamp: integer("source_timestamp", { mode: "timestamp_ms" }),
  sourceQuote: text("source_quote"),
  sourceChannelMode: text("source_channel_mode"),
  id: text("id").primaryKey(),
  memoryId: text("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  sourceMessageId: text("source_message_id"),
  sourceChannelId: text("source_channel_id"),
  assertedByUserId: text("asserted_by_user_id"),
  statement: text("statement").notNull(),
  source: text("source").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// See schema.ts's memoryRelations for the design rationale.
export const memoryRelations = sqliteTable("memory_relations", {
  channelId: text("channel_id"),
  contextProvenance: text("context_provenance", { mode: "json" }).$type<ContextProvenance | null>(),
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  fromSubjectType: text("from_subject_type").notNull(),
  fromSubjectId: text("from_subject_id").notNull(),
  predicate: text("predicate").notNull(),
  // See schema.ts's memoryRelations.kind comment.
  kind: text("kind").notNull().default("association"),
  toSubjectType: text("to_subject_type").notNull(),
  toSubjectId: text("to_subject_id").notNull(),
  isolationChannelId: text("isolation_channel_id"),
  supportingMemoryId: text("supporting_memory_id").references(() => memories.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("memory_relations_guild_from").on(table.guildId, table.fromSubjectType, table.fromSubjectId),
  index("memory_relations_guild_to").on(table.guildId, table.toSubjectType, table.toSubjectId),
  // See schema.ts's memory_relations_identity.
  uniqueIndex("memory_relations_identity").on(
    table.guildId, table.fromSubjectType, table.fromSubjectId, table.predicate, table.kind,
    table.toSubjectType, table.toSubjectId, sql`coalesce(${table.isolationChannelId}, '')`, sql`coalesce(${table.channelId}, '')`,
  ),
]);

// Plan 2 (channel context) — mirrors schema.ts's channelSummaryCheckpoints.
export const channelSummaryCheckpoints = sqliteTable("channel_summary_checkpoints", {
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  lastMessageId: text("last_message_id"),
  scanCompletedAt: integer("scan_completed_at", { mode: "timestamp_ms" }),
  // Daily's in-progress resume cursor — non-null means a capped daily batch
  // stopped partway and should resume `before` this id next tick, instead of
  // re-fetching from the newest message.
  dailyCursor: text("daily_cursor"),
  // Lower boundary for the next daily cycle — null means "use now - 24h".
  // Advances to the completion tick's timestamp once a cycle fully reaches
  // its boundary, so downtime longer than a day (or a multi-tick capped
  // run) never silently loses messages between cycles.
  dailyHighWaterMarkAt: integer("daily_high_water_mark_at", { mode: "timestamp_ms" }),
  lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),
  lastErrorCode: text("last_error_code"),
  lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [primaryKey({ columns: [table.guildId, table.channelId] })]);

// Durable per-author dedicated personal-memory extraction jobs — mirrors
// schema.ts's personalMemoryExtractionJobs. See channel-summary-scheduler.ts:
// one row per (guildId, channelId, batchId, subjectId) rather than doing the
// extraction inline while summarizing a batch, so a member's promotion
// check survives a process restart, isn't lost by an unrelated ingest
// failure elsewhere in the same batch, and can retry with real backoff
// independently of the channel's own scan/daily cursor — which no longer
// needs to be held back waiting on it.
export const personalMemoryExtractionJobs = sqliteTable("personal_memory_extraction_jobs", {
  sourceMessages: text("source_messages", { mode: "json" }).$type<readonly { messageId: string; content: string; timestampMs: number }[]>().notNull().default([]),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  batchId: text("batch_id").notNull(),
  subjectId: text("subject_id").notNull(),
  displayName: text("display_name").notNull(),
  content: text("content").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
  lastError: text("last_error"),
  // "dead_letter" once attempts exhausts maxPersonalMemoryExtractionAttempts
  // — excluded from dequeueDue, kept (not deleted) so it's visible/countable
  // rather than silently vanishing.
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.guildId, table.channelId, table.batchId, table.subjectId] }),
  index("personal_memory_extraction_jobs_due").on(table.status, table.nextAttemptAt),
  // Backs deleteTerminalOlderThan's periodic backstop cleanup of aged
  // succeeded/dead_letter tombstones (see the store interface).
  index("personal_memory_extraction_jobs_terminal").on(table.status, table.updatedAt),
]);

// One row per bot-authored chat reply eligible for the reaction-reply
// feature (see ReactionReplyScheduler) — registered at send time
// (status "watching"), armed to "pending" on its first reaction (dueAt set
// to a fixed window from then), then evaluated once and moved to "done"
// regardless of outcome. messageId alone is the primary key: a Discord
// message id is already a globally unique snowflake, no composite key
// needed the way the extraction-jobs table above needs one (that table's
// identity spans a whole batch, not a single message).
export const messageReactionWatches = sqliteTable("message_reaction_watches", {
  messageId: text("message_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  status: text("status").notNull().default("watching"),
  firstReactionAt: integer("first_reaction_at", { mode: "timestamp_ms" }),
  dueAt: integer("due_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("message_reaction_watches_due").on(table.status, table.dueAt),
  // Backs a periodic retention sweep — a "watching" row nobody ever
  // reacted to, or a "done" row nothing will re-query, both age out.
  index("message_reaction_watches_cleanup").on(table.status, table.updatedAt),
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
