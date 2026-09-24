import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type {
  ActiveSubjectQuery,
  CandidateIdentityQuery,
  CandidateQuery,
  CandidateWithAsserters,
  ForgetQuery,
  Memory,
  MemoryAudience,
  MemoryIdentity,
  MemoryKind,
  MemoryRepository,
  MemorySource,
  MemorySourceKind,
  MemoryStatus,
  MemorySubjectType,
  PromoteCandidateCommand,
  RecallCandidates,
  RelatedSubject,
  RelatedSubjectsQuery,
  RelationCreateInput,
  RepositoryIngestInput,
  SupersedeCommand,
} from "../../application/memory/memory.js";
import * as schema from "../database/schema.js";
import {
  assertersOf, collectRelatedSubjects, maxCandidatesPerIdentity, maxSupersedeChainDepth,
} from "./memory-repository-shared.js";

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

// memories_identity (COALESCE over the nullable columns — see schema.ts)
// rejects a second active row per identity, but two concurrent ingests that
// both see "no active row yet" would have the loser fail on that unique
// violation instead of updating in place. An advisory transaction lock
// keyed by the identity tuple serializes them so the second one sees the
// first's row and takes the ordinary update/revision path. SQLite doesn't
// need this — better-sqlite3 is a single, synchronous connection, so
// there's no true concurrent transaction to race in the first place.
// Joined with a \u0001 separator — a character none of the values (numeric
// snowflakes, slotPattern-validated topic/slot/subjectType) can contain, so
// distinct identity tuples can't collide onto the same joined string. Only
// used as a lock key, never persisted or parsed back.
function identityLockKey(identity: MemoryIdentity): string {
  return [
    identity.guildId, identity.ownerUserId ?? "", identity.channelId ?? "", identity.isolationChannelId ?? "",
    identity.subjectType, identity.subjectId, identity.topic, identity.slot,
  ].join("\u0001");
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

// See SqliteMemoryRepository's identityCondition.
function identityCondition(identity: MemoryIdentity): ReturnType<typeof and> {
  return and(
    eq(schema.memories.guildId, identity.guildId),
    identity.ownerUserId === null ? isNull(schema.memories.ownerUserId) : eq(schema.memories.ownerUserId, identity.ownerUserId),
    identity.channelId === null ? isNull(schema.memories.channelId) : eq(schema.memories.channelId, identity.channelId),
    identity.isolationChannelId === null
      ? isNull(schema.memories.isolationChannelId)
      : eq(schema.memories.isolationChannelId, identity.isolationChannelId),
    eq(schema.memories.subjectType, identity.subjectType),
    eq(schema.memories.subjectId, identity.subjectId),
    eq(schema.memories.topic, identity.topic),
    eq(schema.memories.slot, identity.slot),
  );
}

export class PostgresMemoryRepository implements MemoryRepository {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public async ingest(input: RepositoryIngestInput): Promise<Memory> {
    return this.database.transaction(async (transaction) => {
      // Serializes concurrent ingests for this exact identity — see
      // identityLockKey. Released automatically at transaction end.
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey(input)}, 0))`);
      const identity = identityCondition(input);
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
          // See SqliteMemoryRepository.ingest — a restatement never lowers
          // importance.
          importance: Math.max(existing.importance, input.importance),
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
    //
    // ORDER BY matters here for the same reason: without one, which rows
    // survive the LIMIT once a guild's eligible set exceeds
    // maxEligibleCandidates is implementation-defined — meaning newly-
    // written, usually most-relevant memories could be silently excluded
    // from ranking entirely while old ones always win. Ordering subject-
    // matches first, then most-recently-updated, means the cap always
    // drops the least-likely-relevant rows first instead of an arbitrary
    // set. (This is a cheap, backend-uniform prefilter — not a substitute
    // for real ANN ranking via the memories_embedding_hnsw index, which is
    // a separate, deliberately-deferred scale optimization; see the memory
    // recall/storage plan.)
    // See SqliteMemoryRepository.findRecallCandidates for why the subject-
    // priority term is only added when there's a real expression to rank
    // by — standard SQL (Postgres included) treats a bare integer literal
    // in ORDER BY as a column-position reference, not a constant. Ordered
    // on prioritySubjectIds, NOT subjectIds — the latter already narrows
    // the WHERE clause below, so a priority term keyed on it would be inert.
    const orderByTerms = query.prioritySubjectIds && query.prioritySubjectIds.length > 0
      ? [sql`case when ${inArray(schema.memories.subjectId, [...query.prioritySubjectIds])} then 0 else 1 end`, desc(schema.memories.updatedAt)]
      : [desc(schema.memories.updatedAt)];
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
    )).orderBy(...orderByTerms).limit(maxEligibleCandidates);
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

  public async findSources(memoryId: string): Promise<readonly MemorySource[]> {
    const rows = await this.database.select().from(schema.memorySources)
      .where(eq(schema.memorySources.memoryId, memoryId))
      .orderBy(asc(schema.memorySources.createdAt));
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memoryId,
      sourceMessageId: row.sourceMessageId,
      sourceChannelId: row.sourceChannelId,
      assertedByUserId: row.assertedByUserId,
      statement: row.statement,
      source: row.source as MemorySourceKind,
      createdAt: row.createdAt.getTime(),
    }));
  }

  // See SqliteMemoryRepository.forget — same semantics (memoryId removes the
  // whole supersede chain; bulk forget also clears relations about the
  // subject and the asserter's provenance).
  public async forget(query: ForgetQuery): Promise<number> {
    return this.database.transaction(async (transaction) => {
      if (query.memoryId) {
        const [target] = await transaction.select().from(schema.memories).where(and(
          eq(schema.memories.guildId, query.guildId), eq(schema.memories.id, query.memoryId),
          query.ownerUserId ? eq(schema.memories.ownerUserId, query.ownerUserId) : undefined,
        )).limit(1);
        if (!target) return 0;
        const ids = [target.id];
        let frontier = [target.id];
        for (let depth = 0; depth < maxSupersedeChainDepth && frontier.length > 0; depth++) {
          const predecessors = await transaction.select({ id: schema.memories.id }).from(schema.memories).where(and(
            eq(schema.memories.guildId, query.guildId),
            eq(schema.memories.status, "superseded"),
            inArray(schema.memories.supersededById, frontier),
            target.ownerUserId === null ? isNull(schema.memories.ownerUserId) : eq(schema.memories.ownerUserId, target.ownerUserId),
          ));
          frontier = predecessors.map((row) => row.id).filter((id) => !ids.includes(id));
          ids.push(...frontier);
        }
        const deleted = await transaction.delete(schema.memories).where(inArray(schema.memories.id, ids))
          .returning({ id: schema.memories.id });
        return deleted.length;
      }
      // OR, not AND — see ForgetQuery.subjectId's own comment: a "forget
      // everything about this user" caller needs either condition to catch
      // a row (their own private memories are owned by them; a third-party
      // claim about them, member-subject only, never is).
      const conditions = [
        query.ownerUserId ? eq(schema.memories.ownerUserId, query.ownerUserId) : undefined,
        query.subjectId ? and(eq(schema.memories.subjectType, "member"), eq(schema.memories.subjectId, query.subjectId)) : undefined,
      ].filter((condition) => condition !== undefined);
      let removed = conditions.length > 0
        ? (await transaction.delete(schema.memories).where(and(eq(schema.memories.guildId, query.guildId), or(...conditions)))
            .returning({ id: schema.memories.id })).length
        : 0;
      if (query.subjectId) {
        await transaction.delete(schema.memoryRelations).where(and(
          eq(schema.memoryRelations.guildId, query.guildId),
          or(
            and(eq(schema.memoryRelations.fromSubjectType, "member"), eq(schema.memoryRelations.fromSubjectId, query.subjectId)),
            and(eq(schema.memoryRelations.toSubjectType, "member"), eq(schema.memoryRelations.toSubjectId, query.subjectId)),
          ),
        ));
      }
      if (query.assertedByUserId) {
        const touched = (await transaction.selectDistinct({ id: schema.memories.id }).from(schema.memorySources)
          .innerJoin(schema.memories, eq(schema.memories.id, schema.memorySources.memoryId))
          .where(and(eq(schema.memories.guildId, query.guildId), eq(schema.memorySources.assertedByUserId, query.assertedByUserId))))
          .map((row) => row.id);
        if (touched.length > 0) {
          await transaction.delete(schema.memorySources).where(and(
            inArray(schema.memorySources.memoryId, touched), eq(schema.memorySources.assertedByUserId, query.assertedByUserId),
          ));
          removed += (await transaction.delete(schema.memories).where(and(
            inArray(schema.memories.id, touched), eq(schema.memories.status, "candidate"),
            notExists(transaction.select({ id: schema.memorySources.id }).from(schema.memorySources)
              .where(eq(schema.memorySources.memoryId, schema.memories.id))),
          )).returning({ id: schema.memories.id })).length;
        }
      }
      return removed;
    });
  }

  public async deleteExpiredCandidates(guildId: string, now: number): Promise<number> {
    const deleted = await this.database.delete(schema.memories).where(and(
      eq(schema.memories.guildId, guildId), eq(schema.memories.status, "candidate"),
      isNotNull(schema.memories.expiresAt), lte(schema.memories.expiresAt, new Date(now)),
    )).returning({ id: schema.memories.id });
    return deleted.length;
  }

  public async findCandidatesByIdentity(query: CandidateIdentityQuery): Promise<readonly CandidateWithAsserters[]> {
    const rows = await this.database.select().from(schema.memories).where(and(
      identityCondition(query),
      eq(schema.memories.status, "candidate"),
      ne(schema.memories.id, query.excludeMemoryId),
      or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, new Date(query.now))),
    )).limit(maxCandidatesPerIdentity);
    if (rows.length === 0) return [];
    const sources = await this.database.select({ memoryId: schema.memorySources.memoryId, assertedByUserId: schema.memorySources.assertedByUserId })
      .from(schema.memorySources)
      .where(inArray(schema.memorySources.memoryId, rows.map((row) => row.id)));
    return rows.map((row) => ({ memory: toMemory(row), assertedByUserIds: assertersOf(row.id, sources) }));
  }

  // See SqliteMemoryRepository.promoteCandidate. Takes the same identity
  // lock as ingest(), so a concurrent active write for this identity can't
  // slip in between the "no active row" check and the promotion.
  public async promoteCandidate(command: PromoteCandidateCommand): Promise<Memory | null> {
    return this.database.transaction(async (transaction) => {
      const [target] = await transaction.select().from(schema.memories).where(and(
        eq(schema.memories.guildId, command.guildId), eq(schema.memories.id, command.memoryId),
        eq(schema.memories.status, "candidate"),
      )).limit(1);
      if (!target) return null;
      const targetMemory = toMemory(target);
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey(targetMemory)}, 0))`);
      // Re-check under the lock: a concurrent promotion may have absorbed
      // (deleted) this row while we waited.
      const stillCandidate = await transaction.select({ id: schema.memories.id }).from(schema.memories)
        .where(and(eq(schema.memories.id, target.id), eq(schema.memories.status, "candidate"))).limit(1);
      if (stillCandidate.length === 0) return null;
      const identity = identityCondition(targetMemory);
      const active = await transaction.select({ id: schema.memories.id }).from(schema.memories)
        .where(and(identity, eq(schema.memories.status, "active"))).limit(1);
      if (active.length > 0) return null;
      const absorbed = command.absorbedMemoryIds.length > 0
        ? (await transaction.select({ id: schema.memories.id }).from(schema.memories).where(and(
            identity, eq(schema.memories.status, "candidate"),
            inArray(schema.memories.id, [...command.absorbedMemoryIds]), ne(schema.memories.id, target.id),
          ))).map((row) => row.id)
        : [];
      if (absorbed.length > 0) {
        await transaction.update(schema.memorySources).set({ memoryId: target.id })
          .where(inArray(schema.memorySources.memoryId, absorbed));
        await transaction.delete(schema.memories).where(inArray(schema.memories.id, absorbed));
      }
      const [promoted] = await transaction.update(schema.memories).set({
        status: "active", expiresAt: null, validFrom: new Date(command.now), updatedAt: new Date(command.now),
      }).where(and(eq(schema.memories.id, target.id), eq(schema.memories.status, "candidate"))).returning();
      return promoted ? toMemory(promoted) : null;
    });
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

  public async createRelations(inputs: readonly RelationCreateInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    // ON CONFLICT DO NOTHING against memory_relations_identity — re-extracting
    // a known edge is a no-op, not a duplicate row.
    const inserted = await this.database.insert(schema.memoryRelations).values(inputs.map((input) => ({
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
    }))).onConflictDoNothing().returning({ id: schema.memoryRelations.id });
    return inserted.length;
  }

  // Bounded iterative BFS, not a recursive SQL CTE — see
  // RelatedSubjectsQuery's doc comment in memory.ts for why (drizzle-orm
  // has no withRecursive support). Level-synchronous: each round's query
  // scans only the previous round's newly-discovered subjects, not every
  // visited subject, so a node already fully expanded is never re-queried.
  // Rows are ordered so results don't depend on physical row order — see
  // collectRelatedSubjects.
  public async findRelatedSubjects(query: RelatedSubjectsQuery): Promise<readonly RelatedSubject[]> {
    const querySubjects = new Set(query.subjectIds);
    const visited = new Set<string>(query.subjectIds);
    const results = new Map<string, RelatedSubject>();
    let frontier = [...query.subjectIds];
    for (let hop = 1; hop <= query.maxHops && frontier.length > 0; hop++) {
      const rows = await this.database.select().from(schema.memoryRelations).where(and(
        eq(schema.memoryRelations.guildId, query.guildId),
        or(inArray(schema.memoryRelations.fromSubjectId, frontier), inArray(schema.memoryRelations.toSubjectId, frontier)),
        or(isNull(schema.memoryRelations.isolationChannelId), eq(schema.memoryRelations.isolationChannelId, query.channelId)),
      )).orderBy(asc(schema.memoryRelations.createdAt), asc(schema.memoryRelations.id));
      frontier = collectRelatedSubjects(rows, frontier, hop, querySubjects, visited, results);
    }
    return [...results.values()];
  }
}
