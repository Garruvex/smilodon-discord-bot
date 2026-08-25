import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type {
  ActiveSubjectQuery,
  CandidateQuery,
  ForgetQuery,
  Memory,
  MemoryAudience,
  MemoryKind,
  MemoryRelationKind,
  MemoryRelationPredicate,
  MemoryRepository,
  MemorySourceKind,
  MemoryStatus,
  MemorySubjectType,
  RecallCandidates,
  RelatedSubject,
  RelatedSubjectsQuery,
  RelationCreateInput,
  RepositoryIngestInput,
  SupersedeCommand,
} from "../../application/memory/memory.js";
import * as schema from "../database/schema.js";

// Verified against a real pgvector-enabled Postgres 16 instance (isolation,
// forget, and concurrent-ingest scenarios). Logic deliberately mirrors
// sqlite-memory-repository.ts's structure so any future fix can be ported
// between the two symmetrically.

// findRecallCandidates below is a plain filtered SELECT — it doesn't do a
// vector-distance ORDER BY, so pgvector's HNSW index (memories_embedding_
// hnsw in schema.ts) never comes into play here and doesn't bound its cost.
// Ranking happens in the engine, over whatever this returns, so this still
// needs the same candidate-count ceiling as SqliteMemoryRepository.
const maxEligibleCandidates = 2_000;

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
    validFrom: row.validFrom.getTime(),
    validUntil: row.validUntil ? row.validUntil.getTime() : null,
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
      // Once a claim is "active", a genuinely changed statement gets a new
      // row (close the old one out with validUntil/supersededById, insert a
      // fresh one) instead of mutating it in place — otherwise the prior
      // value is unrecoverable the moment it's corrected. An unchanged
      // restatement (reinforcement) and the still-unconfirmed "candidate"
      // dedup path both update in place; neither represents a value actually
      // changing. See memory.ts's Memory.validFrom/validUntil doc comment.
      const isRevision = existing !== undefined && input.status === "active" && existing.statement !== input.statement;
      let row: typeof schema.memories.$inferSelect;
      if (existing && !isRevision) {
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
        const newId = randomUUID();
        if (existing && isRevision) {
          await transaction.update(schema.memories).set({
            status: "superseded",
            supersededById: newId,
            validUntil: new Date(input.now),
            updatedAt: new Date(input.now),
          }).where(eq(schema.memories.id, existing.id));
        }
        const inserted = await transaction.insert(schema.memories).values({
          id: newId,
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
          validFrom: new Date(input.now),
          validUntil: null,
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
    // subjectIds, when given, is applied in SQL alongside the other filters
    // — not as a post-fetch JS filter — so it narrows what the LIMIT below
    // bounds rather than being applied after it. Filtering after a LIMIT
    // would silently drop a requested subject's memories whenever the
    // unfiltered eligible set exceeds maxEligibleCandidates and happens to
    // sort the requested subject's rows past the cutoff.
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
      query.subjectIds && query.subjectIds.length > 0 ? inArray(schema.memories.subjectId, [...query.subjectIds]) : undefined,
    )).limit(maxEligibleCandidates);
    return { memories: rows.map(toMemory) };
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

  // Bounded — a subject shouldn't realistically accumulate more than a few
  // dozen active memories; the limit protects the conflict check from
  // scanning an unbounded set rather than reflecting an expected scale.
  public async findActiveBySubject(query: ActiveSubjectQuery): Promise<readonly Memory[]> {
    const rows = await this.database.select().from(schema.memories).where(and(
      eq(schema.memories.guildId, query.guildId),
      eq(schema.memories.subjectType, query.subjectType),
      eq(schema.memories.subjectId, query.subjectId),
      eq(schema.memories.status, "active"),
      ne(schema.memories.id, query.excludeMemoryId),
      eq(schema.memories.audience, query.audience),
      query.ownerUserId === null ? isNull(schema.memories.ownerUserId) : eq(schema.memories.ownerUserId, query.ownerUserId),
      query.channelId === null ? isNull(schema.memories.channelId) : eq(schema.memories.channelId, query.channelId),
      query.isolationChannelId === null
        ? isNull(schema.memories.isolationChannelId)
        : eq(schema.memories.isolationChannelId, query.isolationChannelId),
    )).limit(50);
    return rows.map(toMemory);
  }

  public async supersede(command: SupersedeCommand): Promise<boolean> {
    const updated = await this.database.update(schema.memories).set({
      status: "superseded",
      supersededById: command.supersededById,
      validUntil: new Date(command.now),
      updatedAt: new Date(command.now),
    }).where(and(
      eq(schema.memories.guildId, command.guildId),
      eq(schema.memories.id, command.memoryId),
      eq(schema.memories.status, "active"),
    )).returning({ id: schema.memories.id });
    return updated.length > 0;
  }

  public async createRelations(inputs: readonly RelationCreateInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.database.insert(schema.memoryRelations).values(inputs.map((input) => ({
      id: randomUUID(),
      guildId: input.guildId,
      fromSubjectType: input.fromSubjectType,
      fromSubjectId: input.fromSubjectId,
      predicate: input.predicate,
      kind: input.kind,
      toSubjectType: input.toSubjectType,
      toSubjectId: input.toSubjectId,
      isolationChannelId: input.isolationChannelId,
      supportingMemoryId: input.supportingMemoryId,
      createdAt: new Date(input.now),
    })));
  }

  // Bounded iterative BFS, not a recursive SQL CTE — see
  // RelatedSubjectsQuery's doc comment in memory.ts for why (drizzle-orm
  // has no withRecursive support). Level-synchronous: each round's query
  // scans only the previous round's newly-discovered subjects, not every
  // visited subject, so a node already fully expanded is never re-queried.
  public async findRelatedSubjects(query: RelatedSubjectsQuery): Promise<readonly RelatedSubject[]> {
    const visited = new Set<string>(query.subjectIds);
    const results = new Map<string, RelatedSubject>();
    let frontier = [...query.subjectIds];
    for (let hop = 1; hop <= query.maxHops && frontier.length > 0; hop++) {
      const rows = await this.database.select().from(schema.memoryRelations).where(and(
        eq(schema.memoryRelations.guildId, query.guildId),
        or(inArray(schema.memoryRelations.fromSubjectId, frontier), inArray(schema.memoryRelations.toSubjectId, frontier)),
        or(isNull(schema.memoryRelations.isolationChannelId), eq(schema.memoryRelations.isolationChannelId, query.channelId)),
      ));
      const nextFrontier: string[] = [];
      for (const row of rows) {
        const fromInFrontier = frontier.includes(row.fromSubjectId);
        const otherSubjectType = fromInFrontier ? row.toSubjectType : row.fromSubjectType;
        const otherSubjectId = fromInFrontier ? row.toSubjectId : row.fromSubjectId;
        const viaSubjectType = fromInFrontier ? row.fromSubjectType : row.toSubjectType;
        const viaSubjectId = fromInFrontier ? row.fromSubjectId : row.toSubjectId;
        if (visited.has(otherSubjectId)) continue;
        visited.add(otherSubjectId);
        nextFrontier.push(otherSubjectId);
        results.set(otherSubjectId, {
          subjectType: otherSubjectType as MemorySubjectType,
          subjectId: otherSubjectId,
          hopDistance: hop,
          kind: row.kind as MemoryRelationKind,
          predicate: row.predicate as MemoryRelationPredicate,
          viaSubjectId,
          viaSubjectType: viaSubjectType as MemorySubjectType,
        });
      }
      frontier = nextFrontier;
    }
    return [...results.values()];
  }
}
