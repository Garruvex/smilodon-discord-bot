import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

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
    validFrom: row.validFrom.getTime(),
    validUntil: row.validUntil ? row.validUntil.getTime() : null,
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
        : ((): typeof schema.memories.$inferSelect | undefined => {
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
      // Once a claim is "active", a genuinely changed statement gets a new
      // row (close the old one out with validUntil/supersededById, insert a
      // fresh one) instead of mutating it in place — otherwise the prior
      // value is unrecoverable the moment it's corrected. An unchanged
      // restatement (reinforcement) and the still-unconfirmed "candidate"
      // dedup path both update in place; neither represents a value actually
      // changing. See memory.ts's Memory.validFrom/validUntil doc comment.
      const isRevision = existing !== undefined && input.status === "active" && existing.statement !== input.statement;
      const row = existing && !isRevision ? existing : transaction.insert(schema.memories).values({
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
        validFrom: new Date(input.now),
        validUntil: null,
      }).returning().get();
      if (existing && !isRevision) {
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
      if (existing && isRevision) {
        transaction.update(schema.memories).set({
          status: "superseded",
          supersededById: row.id,
          validUntil: new Date(input.now),
          updatedAt: new Date(input.now),
        }).where(eq(schema.memories.id, existing.id)).run();
      }
      // Idempotent retry guard — see postgres-memory-repository.ts's ingest
      // for the rationale (stable batch-derived sourceMessageId from
      // ChannelSummaryScheduler must not duplicate provenance on retry).
      const alreadyRecorded = input.sourceMessageId !== null && transaction.select({ id: schema.memorySources.id })
        .from(schema.memorySources)
        .where(and(eq(schema.memorySources.memoryId, row.id), eq(schema.memorySources.sourceMessageId, input.sourceMessageId)))
        .get() !== undefined;
      if (!alreadyRecorded) {
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
      }
      return existing && !isRevision
        ? { ...row, statement: input.statement, confidence: input.confidence, importance: input.importance, embedding: input.embedding ? [...input.embedding] : null, updatedAt: new Date(input.now) }
        : row;
    });
    return Promise.resolve(toMemory(result));
  }

  public findRecallCandidates(query: CandidateQuery): Promise<RecallCandidates> {
    // subjectIds, when given, is applied in SQL alongside the other filters
    // — not as a post-fetch JS filter — so it narrows what the LIMIT below
    // bounds rather than being applied after it. Filtering after a LIMIT
    // would silently drop a requested subject's memories whenever the
    // unfiltered eligible set exceeds maxEligibleCandidates and happens to
    // sort the requested subject's rows past the cutoff.
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
      query.subjectIds && query.subjectIds.length > 0 ? inArray(schema.memories.subjectId, [...query.subjectIds]) : undefined,
    )).limit(maxEligibleCandidates).all();
    return Promise.resolve({ memories: rows.map(toMemory) });
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

  // See PostgresMemoryRepository.findActiveBySubject for the bound rationale.
  public findActiveBySubject(query: ActiveSubjectQuery): Promise<readonly Memory[]> {
    const rows = this.database.select().from(schema.memories).where(and(
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
    )).limit(50).all();
    return Promise.resolve(rows.map(toMemory));
  }

  public supersede(command: SupersedeCommand): Promise<boolean> {
    const result = this.database.update(schema.memories).set({
      status: "superseded",
      supersededById: command.supersededById,
      validUntil: new Date(command.now),
      updatedAt: new Date(command.now),
    }).where(and(
      eq(schema.memories.guildId, command.guildId),
      eq(schema.memories.id, command.memoryId),
      eq(schema.memories.status, "active"),
    )).run();
    return Promise.resolve(result.changes > 0);
  }

  public createRelations(inputs: readonly RelationCreateInput[]): Promise<void> {
    if (inputs.length === 0) return Promise.resolve();
    this.database.insert(schema.memoryRelations).values(inputs.map((input) => ({
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
    }))).run();
    return Promise.resolve();
  }

  // See PostgresMemoryRepository.findRelatedSubjects for the BFS rationale
  // (bounded iterative, not a recursive SQL CTE).
  public findRelatedSubjects(query: RelatedSubjectsQuery): Promise<readonly RelatedSubject[]> {
    const visited = new Set<string>(query.subjectIds);
    const results = new Map<string, RelatedSubject>();
    let frontier = [...query.subjectIds];
    for (let hop = 1; hop <= query.maxHops && frontier.length > 0; hop++) {
      const rows = this.database.select().from(schema.memoryRelations).where(and(
        eq(schema.memoryRelations.guildId, query.guildId),
        or(inArray(schema.memoryRelations.fromSubjectId, frontier), inArray(schema.memoryRelations.toSubjectId, frontier)),
        or(isNull(schema.memoryRelations.isolationChannelId), eq(schema.memoryRelations.isolationChannelId, query.channelId)),
      )).all();
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
    return Promise.resolve([...results.values()]);
  }
}
