import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

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
import * as schema from "../database/sqlite-schema.js";

// SQLite has no ANN index — findRecallCandidates does SQL-side authorization
// filtering + bounding only; embedding/BM25 ranking happens in the engine
// (see memory-engine.ts), identically to the Postgres path. This cap is the
// "maximumEligibleVectorScan" ceiling from the plan's SQLite-ceiling section.
const maxEligibleCandidates = 2_000;

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

// See sqlite-chat-state-store.ts's header comment on why every query here
// uses a terminal `.all()`/`.get()`/`.run()` call rather than `await` —
// better-sqlite3's `.transaction()` requires a synchronous callback.
export class SqliteMemoryRepository implements MemoryRepository {
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}

  public ingest(input: RepositoryIngestInput): Promise<Memory> {
    const result = this.database.transaction((transaction) => {
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
      // "active" is uniquely constrained per identity (partial unique index)
      // — always update-in-place. "candidate" rows aren't DB-constrained
      // (multiple conflicting claims may coexist under the same identity),
      // so dedup only against a prior candidate from the same asserter (via
      // its memory_sources row) — that avoids one user spamming duplicates
      // without merging different users' differing claims into one row.
      const existing = input.status === "active"
        ? transaction.select().from(schema.memories).where(and(identity, eq(schema.memories.status, "active"))).get()
        : (() => {
            const ownSourceMatch = transaction.select({ id: schema.memories.id })
              .from(schema.memories)
              .innerJoin(schema.memorySources, eq(schema.memorySources.memoryId, schema.memories.id))
              .where(and(
                identity, eq(schema.memories.status, "candidate"),
                input.assertedByUserId === null
                  ? isNull(schema.memorySources.assertedByUserId)
                  : eq(schema.memorySources.assertedByUserId, input.assertedByUserId),
              )).get();
            return ownSourceMatch
              ? transaction.select().from(schema.memories).where(eq(schema.memories.id, ownSourceMatch.id)).get()
              : undefined;
          })();
      const row = existing ?? transaction.insert(schema.memories).values({
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
      }).returning().get();
      if (existing) {
        transaction.update(schema.memories).set({
          statement: input.statement,
          structuredValue: input.structuredValue ?? null,
          confidence: input.confidence,
          importance: input.importance,
          embedding: input.embedding ? [...input.embedding] : null,
          embeddingModel: input.embeddingModel,
          updatedAt: new Date(input.now),
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        }).where(eq(schema.memories.id, existing.id)).run();
      }
      transaction.insert(schema.memorySources).values({
        id: randomUUID(),
        memoryId: row.id,
        sourceMessageId: input.sourceMessageId,
        sourceChannelId: input.sourceChannelId,
        assertedByUserId: input.assertedByUserId,
        statement: input.statement,
        source: input.source,
        createdAt: new Date(input.now),
      }).run();
      return existing ? { ...row, statement: input.statement, confidence: input.confidence, importance: input.importance, embedding: input.embedding ? [...input.embedding] : null, updatedAt: new Date(input.now) } : row;
    });
    return Promise.resolve(toMemory(result));
  }

  public findRecallCandidates(query: CandidateQuery): Promise<RecallCandidates> {
    const rows = this.database.select().from(schema.memories).where(and(
      eq(schema.memories.guildId, query.guildId),
      eq(schema.memories.status, "active"),
      or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, new Date(query.now))),
      or(isNull(schema.memories.isolationChannelId), eq(schema.memories.isolationChannelId, query.channelId)),
      or(
        and(eq(schema.memories.audience, "private"), eq(schema.memories.ownerUserId, query.userId)),
        and(eq(schema.memories.audience, "channel"), eq(schema.memories.channelId, query.channelId)),
        eq(schema.memories.audience, "guild"),
      ),
    )).limit(maxEligibleCandidates).all();
    const filtered = query.subjectIds && query.subjectIds.length > 0
      ? rows.filter((row) => query.subjectIds!.includes(row.subjectId))
      : rows;
    return Promise.resolve({ memories: filtered.map(toMemory) });
  }

  public findById(guildId: string, id: string): Promise<Memory | null> {
    const row = this.database.select().from(schema.memories)
      .where(and(eq(schema.memories.guildId, guildId), eq(schema.memories.id, id))).get();
    return Promise.resolve(row ? toMemory(row) : null);
  }

  public listByUser(guildId: string, userId: string): Promise<Memory[]> {
    const rows = this.database.select().from(schema.memories).where(and(
      eq(schema.memories.guildId, guildId),
      eq(schema.memories.ownerUserId, userId),
      or(eq(schema.memories.status, "active"), eq(schema.memories.status, "candidate")),
    )).all();
    return Promise.resolve(rows.map(toMemory));
  }

  public forget(query: ForgetQuery): Promise<number> {
    if (query.memoryId) {
      const result = this.database.delete(schema.memories).where(and(
        eq(schema.memories.guildId, query.guildId), eq(schema.memories.id, query.memoryId),
      )).run();
      return Promise.resolve(result.changes);
    }
    if (query.ownerUserId) {
      const result = this.database.delete(schema.memories).where(and(
        eq(schema.memories.guildId, query.guildId), eq(schema.memories.ownerUserId, query.ownerUserId),
      )).run();
      return Promise.resolve(result.changes);
    }
    return Promise.resolve(0);
  }
}
