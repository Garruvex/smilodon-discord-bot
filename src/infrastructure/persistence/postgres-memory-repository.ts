import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type {
  CandidateQuery,
  ForgetQuery,
  Memory,
  MemoryAudience,
  MemoryKind,
  MemoryRepository,
  MemorySourceKind,
  MemoryStatus,
  MemorySubjectType,
  RecallCandidates,
  RepositoryIngestInput,
} from "../../application/memory/memory.js";
import * as schema from "../database/schema.js";

// Postgres has pgvector + HNSW (see schema.ts's memories_embedding_hnsw
// index), so unlike SqliteMemoryRepository this has no candidate-count
// ceiling — the index bounds the cost. Verified against a real pgvector-
// enabled Postgres 16 instance (isolation, forget, and concurrent-ingest
// scenarios). Logic deliberately mirrors sqlite-memory-repository.ts's
// structure so any future fix can be ported between the two symmetrically.

// Postgres unique indexes treat NULL as distinct from NULL by default (no
// NULLS NOT DISTINCT support in this drizzle-orm version's index builder),
// so the partial unique index on `memories` alone does NOT prevent two
// concurrent transactions from both inserting an "active" row for the same
// identity when any of ownerUserId/channelId/isolationChannelId is null —
// which private memory (channelId/isolationChannelId null) and shared/
// guild-wide memory (ownerUserId null) both routinely are. Confirmed by a
// live concurrency test. An advisory transaction lock keyed by the identity
// tuple closes this: it serializes concurrent ingests for the same identity
// regardless of which columns are null, without depending on unique-index
// NULL semantics at all. SQLite doesn't need this — better-sqlite3 is a
// single, synchronous connection, so there's no true concurrent transaction
// to race in the first place.
// No separator between fields — every value here is drawn from a
// restricted character set upstream (snowflakes are numeric; topic/slot/
// subjectType are validated by memory-validation.ts's slotPattern), so
// distinct identity tuples can't collide onto the same joined string. Only
// used as a lock key, never persisted or parsed back.
function identityLockKey(input: RepositoryIngestInput): string {
  return [
    input.guildId, input.ownerUserId ?? "", input.channelId ?? "", input.isolationChannelId ?? "",
    input.subjectType, input.subjectId, input.topic, input.slot,
  ].join("");
}

function toMemory(row: typeof schema.memories.$inferSelect): Memory {
  return {
    id: row.id,
    guildId: row.guildId,
    kind: row.kind as MemoryKind,
    audience: row.audience as MemoryAudience,
    ownerUserId: row.ownerUserId,
    channelId: row.channelId,
    isolationChannelId: row.isolationChannelId,
    subjectType: row.subjectType as MemorySubjectType,
    subjectId: row.subjectId,
    topic: row.topic,
    slot: row.slot,
    statement: row.statement,
    structuredValue: row.structuredValue ?? null,
    status: row.status as MemoryStatus,
    supersededById: row.supersededById,
    source: row.source as MemorySourceKind,
    confidence: row.confidence,
    importance: row.importance,
    embedding: row.embedding ?? null,
    embeddingModel: row.embeddingModel,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
  };
}

export class PostgresMemoryRepository implements MemoryRepository {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public async ingest(input: RepositoryIngestInput): Promise<Memory> {
    return this.database.transaction(async (transaction) => {
      // Serializes concurrent ingests for this exact identity — see the
      // NULLS NOT DISTINCT note above for why the unique index alone can't
      // do this. Released automatically at transaction end.
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey(input)}, 0))`);
      const identity = and(
        eq(schema.memories.guildId, input.guildId),
        input.ownerUserId === null ? isNull(schema.memories.ownerUserId) : eq(schema.memories.ownerUserId, input.ownerUserId),
        input.channelId === null ? isNull(schema.memories.channelId) : eq(schema.memories.channelId, input.channelId),
        input.isolationChannelId === null ? isNull(schema.memories.isolationChannelId) : eq(schema.memories.isolationChannelId, input.isolationChannelId),
        eq(schema.memories.subjectType, input.subjectType),
        eq(schema.memories.subjectId, input.subjectId),
        eq(schema.memories.topic, input.topic),
        eq(schema.memories.slot, input.slot),
      );
      // See SqliteMemoryRepository.ingest for the identity/dedup rationale
      // (partial-unique "active" row vs. per-asserter "candidate" dedup).
      let existing: typeof schema.memories.$inferSelect | undefined;
      if (input.status === "active") {
        const rows = await transaction.select().from(schema.memories)
          .where(and(identity, eq(schema.memories.status, "active"))).limit(1);
        existing = rows[0];
      } else {
        const rows = await transaction.select({ memory: schema.memories })
          .from(schema.memories)
          .innerJoin(schema.memorySources, eq(schema.memorySources.memoryId, schema.memories.id))
          .where(and(
            identity, eq(schema.memories.status, "candidate"),
            input.assertedByUserId === null
              ? isNull(schema.memorySources.assertedByUserId)
              : eq(schema.memorySources.assertedByUserId, input.assertedByUserId),
          )).limit(1);
        existing = rows[0]?.memory;
      }
      let row: typeof schema.memories.$inferSelect;
      if (existing) {
        const updated = await transaction.update(schema.memories).set({
          statement: input.statement,
          structuredValue: input.structuredValue ?? null,
          confidence: input.confidence,
          importance: input.importance,
          embedding: input.embedding ? [...input.embedding] : null,
          embeddingModel: input.embeddingModel,
          updatedAt: new Date(input.now),
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        }).where(eq(schema.memories.id, existing.id)).returning();
        row = updated[0]!;
      } else {
        const inserted = await transaction.insert(schema.memories).values({
          id: randomUUID(),
          guildId: input.guildId,
          kind: input.kind,
          audience: input.audience,
          ownerUserId: input.ownerUserId,
          channelId: input.channelId,
          isolationChannelId: input.isolationChannelId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          topic: input.topic,
          slot: input.slot,
          statement: input.statement,
          structuredValue: input.structuredValue ?? null,
          status: input.status,
          source: input.source,
          confidence: input.confidence,
          importance: input.importance,
          embedding: input.embedding ? [...input.embedding] : null,
          embeddingModel: input.embeddingModel,
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        }).returning();
        row = inserted[0]!;
      }
      // Idempotent retry guard: a background batch (see
      // ChannelSummaryScheduler) passes a stable batch-derived id as
      // sourceMessageId, so retrying the same batch after a partial failure
      // re-upserts the memory in place but must not add a second provenance
      // row for it. Live-chat sourceMessageId (a real Discord message id)
      // is naturally unique per call, so this is a no-op there.
      const alreadyRecorded = input.sourceMessageId !== null && (await transaction.select({ id: schema.memorySources.id })
        .from(schema.memorySources)
        .where(and(eq(schema.memorySources.memoryId, row.id), eq(schema.memorySources.sourceMessageId, input.sourceMessageId)))
        .limit(1)).length > 0;
      if (!alreadyRecorded) {
        await transaction.insert(schema.memorySources).values({
          id: randomUUID(),
          memoryId: row.id,
          sourceMessageId: input.sourceMessageId,
          sourceChannelId: input.sourceChannelId,
          assertedByUserId: input.assertedByUserId,
          statement: input.statement,
          source: input.source,
          createdAt: new Date(input.now),
        });
      }
      return toMemory(row);
    });
  }

  public async findRecallCandidates(query: CandidateQuery): Promise<RecallCandidates> {
    const rows = await this.database.select().from(schema.memories).where(and(
      eq(schema.memories.guildId, query.guildId),
      eq(schema.memories.status, "active"),
      or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, new Date(query.now))),
      or(isNull(schema.memories.isolationChannelId), eq(schema.memories.isolationChannelId, query.channelId)),
      or(
        and(eq(schema.memories.audience, "private"), eq(schema.memories.ownerUserId, query.userId)),
        and(eq(schema.memories.audience, "channel"), eq(schema.memories.channelId, query.channelId)),
        eq(schema.memories.audience, "guild"),
      ),
    ));
    const filtered = query.subjectIds && query.subjectIds.length > 0
      ? rows.filter((row) => query.subjectIds!.includes(row.subjectId))
      : rows;
    return { memories: filtered.map(toMemory) };
  }

  public async findById(guildId: string, id: string): Promise<Memory | null> {
    const rows = await this.database.select().from(schema.memories)
      .where(and(eq(schema.memories.guildId, guildId), eq(schema.memories.id, id))).limit(1);
    return rows[0] ? toMemory(rows[0]) : null;
  }

  public async listByUser(guildId: string, userId: string): Promise<Memory[]> {
    const rows = await this.database.select().from(schema.memories).where(and(
      eq(schema.memories.guildId, guildId),
      eq(schema.memories.ownerUserId, userId),
      or(eq(schema.memories.status, "active"), eq(schema.memories.status, "candidate")),
    ));
    return rows.map(toMemory);
  }

  public async forget(query: ForgetQuery): Promise<number> {
    if (query.memoryId) {
      const deleted = await this.database.delete(schema.memories).where(and(
        eq(schema.memories.guildId, query.guildId), eq(schema.memories.id, query.memoryId),
      )).returning({ id: schema.memories.id });
      return deleted.length;
    }
    if (query.ownerUserId) {
      const deleted = await this.database.delete(schema.memories).where(and(
        eq(schema.memories.guildId, query.guildId), eq(schema.memories.ownerUserId, query.ownerUserId),
      )).returning({ id: schema.memories.id });
      return deleted.length;
    }
    return 0;
  }
}
