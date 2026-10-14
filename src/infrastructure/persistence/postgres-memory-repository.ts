import { randomUUID } from "node:crypto";
import type { ChannelMemoryMode } from "../../application/memory/memory-channel-policy.js";
import { aliasQueryTokens, observedSubjectNames } from "../../application/memory/observed-subject-names.js";

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
  assertersOf, collectRelatedSubjects, maxCandidatesPerIdentity, maxSupersedeChainDepth, retainCallbackMetadata,
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
    identity.moduleId ?? "",
    identity.subjectType, identity.subjectId, identity.topic, identity.slot,
  ].join("\u0001");
}

function toMemory(row: typeof schema.memories.$inferSelect): Memory {
  return {
    id: row.id,
    guildId: row.guildId,
    moduleId: row.moduleId,
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
    identity.moduleId == null ? isNull(schema.memories.moduleId) : eq(schema.memories.moduleId, identity.moduleId),
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
  public async findObservedAliases(input: CandidateQuery & { message: string }): Promise<{ alias: string; subjectId: string }[]> {
    const tokens = aliasQueryTokens(input.message);
    if (!tokens.length) return [];
    const rows = await this.database.execute<{ alias: string; subjectId: string }>(sql`
      SELECT a.alias AS alias, m.subject_id AS "subjectId"
      FROM memory_observed_aliases a JOIN memories m ON m.id = a.memory_id
      WHERE a.guild_id = ${input.guildId} AND a.alias IN (${sql.join(tokens.map((token) => sql`${token}`), sql`, `)})
        AND m.guild_id = ${input.guildId} AND m.subject_type = 'member' AND m.status = 'active'
        AND m.module_id IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > ${new Date(input.now)})
        AND (m.isolation_channel_id IS NULL OR m.isolation_channel_id = ${input.channelId})
        AND (m.audience = 'guild' OR (m.audience = 'channel' AND m.channel_id = ${input.channelId})
          OR (m.audience = 'private' AND m.owner_user_id = ${input.userId}))
      GROUP BY alias, m.subject_id LIMIT 512
    `);
    return [...rows];
  }
  public async reclassifyPublicMemory(input: { guildId: string; memoryId: string; sourceMessageId: string; sourceChannelId: string;
    assertedByUserId: string; sourceQuote: string; mode: "shared" | "isolated"; sourceTimestampMs?: number; now: number }): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [memory] = await transaction.select().from(schema.memories).where(and(
        eq(schema.memories.guildId, input.guildId), eq(schema.memories.id, input.memoryId),
        isNull(schema.memories.moduleId),
        eq(schema.memories.audience, "private"), eq(schema.memories.subjectType, "member"),
        eq(schema.memories.subjectId, input.assertedByUserId), eq(schema.memories.ownerUserId, input.assertedByUserId),
      )).limit(1).for("update");
      if (!memory) return false;
      const [source] = await transaction.select().from(schema.memorySources).where(and(
        eq(schema.memorySources.memoryId, memory.id), eq(schema.memorySources.sourceMessageId, input.sourceMessageId),
        eq(schema.memorySources.sourceChannelId, input.sourceChannelId), eq(schema.memorySources.assertedByUserId, input.assertedByUserId),
      )).limit(1);
      if (!source) return false;
      const isolated = input.mode === "isolated" || memory.isolationChannelId !== null;
      if (memory.isolationChannelId && memory.isolationChannelId !== input.sourceChannelId) return false;
      await transaction.update(schema.memories).set({
        audience: isolated || memory.kind === "episode" ? "channel" : "guild", ownerUserId: null,
        channelId: isolated || memory.kind === "episode" ? input.sourceChannelId : null,
        isolationChannelId: isolated ? input.sourceChannelId : null, updatedAt: new Date(input.now),
      }).where(eq(schema.memories.id, memory.id));
      await transaction.update(schema.memorySources).set({ sourceQuote: input.sourceQuote, sourceChannelMode: input.mode,
        sourceTimestamp: input.sourceTimestampMs === undefined ? source.sourceTimestamp : new Date(input.sourceTimestampMs) })
        .where(eq(schema.memorySources.id, source.id));
      return true;
    });
  }
  public async recordForgetCutoff(input: { guildId: string; subjectId: string; topic: string; slot: string; scopeKey: string; cutoff: number }): Promise<void> {
    await this.database.insert(schema.memoryForgetCutoffs).values({ ...input, cutoff: new Date(input.cutoff) }).onConflictDoUpdate({
      target: [schema.memoryForgetCutoffs.guildId, schema.memoryForgetCutoffs.subjectId, schema.memoryForgetCutoffs.topic, schema.memoryForgetCutoffs.slot, schema.memoryForgetCutoffs.scopeKey],
      set: { cutoff: new Date(input.cutoff) },
    });
  }

  public async isSourceForgotten(input: { guildId: string; subjectId: string; topic: string; slot: string; channelId: string; sourceTimestampMs: number }): Promise<boolean> {
    const rows = await this.database.select().from(schema.memoryForgetCutoffs).where(and(
      eq(schema.memoryForgetCutoffs.guildId, input.guildId), eq(schema.memoryForgetCutoffs.subjectId, input.subjectId),
      or(eq(schema.memoryForgetCutoffs.scopeKey, "*"), eq(schema.memoryForgetCutoffs.scopeKey, input.channelId)),
      or(eq(schema.memoryForgetCutoffs.topic, "*"), eq(schema.memoryForgetCutoffs.topic, input.topic)),
      or(eq(schema.memoryForgetCutoffs.slot, "*"), eq(schema.memoryForgetCutoffs.slot, input.slot)),
    ));
    return rows.some((row) => row.cutoff.getTime() >= input.sourceTimestampMs);
  }
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public async ingest(input: RepositoryIngestInput): Promise<Memory> {
    if (input.moduleId != null && !/^[a-z][a-z0-9.-]{0,63}$/.test(input.moduleId)) {
      throw new Error("Invalid memory module ID");
    }
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
          structuredValue: retainCallbackMetadata(existing.structuredValue, input.structuredValue ?? null, false, input.now),
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
          moduleId: input.moduleId ?? null,
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
          structuredValue: retainCallbackMetadata(existing?.structuredValue, input.structuredValue ?? null, isRevision, input.now),
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
          sourceQuote: input.sourceQuote ?? null,
          sourceTimestamp: input.sourceTimestampMs === undefined || input.sourceTimestampMs === null ? null : new Date(input.sourceTimestampMs),
          sourceChannelMode: input.sourceChannelMode ?? null,
          sourceMessageId: input.sourceMessageId,
          sourceChannelId: input.sourceChannelId,
          assertedByUserId: input.assertedByUserId,
          statement: input.statement,
          source: input.source,
          createdAt: new Date(input.now),
        });
      }
      await transaction.delete(schema.memoryObservedAliases).where(eq(schema.memoryObservedAliases.memoryId, row.id));
      const aliases = [...new Set(observedSubjectNames(toMemory(row)).map((name) => name.value.toLowerCase()).filter((name) => name.length >= 2))];
      if (aliases.length) await transaction.insert(schema.memoryObservedAliases).values(aliases.map((alias) => ({ guildId: row.guildId, memoryId: row.id, alias })));
      return toMemory(row);
    });
  }

  public async findRecallCandidates(query: CandidateQuery): Promise<RecallCandidates> {
    return this.selectCandidates(query, null);
  }
  public findModuleCandidates(query: CandidateQuery & { moduleId: string }): Promise<RecallCandidates> {
    return this.selectCandidates(query, query.moduleId);
  }
  public async deleteExpiredModuleData(guildId: string, now: number, historyDays: number): Promise<number> {
    const rows = await this.database.delete(schema.memories).where(and(eq(schema.memories.guildId, guildId), isNotNull(schema.memories.moduleId),
      or(and(isNotNull(schema.memories.expiresAt), lte(schema.memories.expiresAt, new Date(now))),
        and(ne(schema.memories.status, "active"), lte(schema.memories.updatedAt, new Date(now - historyDays * 86_400_000)))))).returning({ id: schema.memories.id });
    return rows.length;
  }
  public async clearModuleData(guildId: string, moduleId: string): Promise<number> {
    const rows = await this.database.delete(schema.memories).where(and(eq(schema.memories.guildId, guildId), eq(schema.memories.moduleId, moduleId))).returning({ id: schema.memories.id });
    return rows.length;
  }
  public async compareAndSetStructuredValue(input: { guildId: string; memoryId: string; updatedAt: number; expected: unknown; value: unknown }): Promise<boolean> {
    const rows = await this.database.update(schema.memories).set({ structuredValue: input.value }).where(and(
      eq(schema.memories.guildId, input.guildId), eq(schema.memories.id, input.memoryId), eq(schema.memories.status, "active"),
      eq(schema.memories.updatedAt, new Date(input.updatedAt)),
      input.expected == null ? isNull(schema.memories.structuredValue) : eq(schema.memories.structuredValue, input.expected),
    )).returning({ id: schema.memories.id });
    return rows.length === 1;
  }
  public claimCallbackMemory(input: { guildId: string; memoryId: string; updatedAt: number; expected: unknown; value: unknown; maxPerDay: number; dayStart: number; now: number }): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`callback:${input.guildId}`}, 0))`);
      const [row] = await transaction.select({ count: sql<number>`cast(count(distinct ${schema.memories.structuredValue}->'callback'->>'attemptId') as integer)` }).from(schema.memories).where(and(
        eq(schema.memories.guildId, input.guildId), ne(schema.memories.id, input.memoryId),
        sql`(${schema.memories.structuredValue}->'callback'->>'quotaDayStart')::numeric >= ${input.dayStart}`,
        sql`((${schema.memories.structuredValue}->'callback'->>'status') in ('sending', 'delivered', 'uncertain') or
          ((${schema.memories.structuredValue}->'callback'->>'status') = 'claimed' and (${schema.memories.structuredValue}->'callback'->>'leaseUntil')::numeric > ${input.now}))`,
      ));
      if ((row?.count ?? 0) >= input.maxPerDay) return false;
      const changed = await transaction.update(schema.memories).set({ structuredValue: input.value }).where(and(
        eq(schema.memories.guildId, input.guildId), eq(schema.memories.id, input.memoryId), eq(schema.memories.status, "active"),
        eq(schema.memories.updatedAt, new Date(input.updatedAt)),
        input.expected == null ? isNull(schema.memories.structuredValue) : eq(schema.memories.structuredValue, input.expected),
      )).returning({ id: schema.memories.id });
      return changed.length === 1;
    });
  }
  public findDueCallbackCandidates(query: CandidateQuery): Promise<RecallCandidates> { return this.selectCandidates(query, null, true); }
  private async selectCandidates(query: CandidateQuery, moduleId: string | null, dueCallbacks = false): Promise<RecallCandidates> {
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
      moduleId === null ? isNull(schema.memories.moduleId) : eq(schema.memories.moduleId, moduleId),
      dueCallbacks ? sql`(${schema.memories.structuredValue}->'callback'->>'dueAt')::numeric <= ${query.now}
        and (${schema.memories.structuredValue}->'callback'->>'nextAttemptAt')::numeric <= ${query.now}
        and (${schema.memories.structuredValue}->'callback'->>'expiresAt')::numeric > ${query.now}
        and (${schema.memories.structuredValue}->'callback'->>'status') in ('pending', 'claimed', 'sending')` : undefined,
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
      sourceQuote: row.sourceQuote,
      sourceTimestampMs: row.sourceTimestamp?.getTime() ?? null,
      sourceChannelMode: row.sourceChannelMode as ChannelMemoryMode | null,
      sourceMessageId: row.sourceMessageId,
      sourceChannelId: row.sourceChannelId,
      assertedByUserId: row.assertedByUserId,
      statement: row.statement,
      source: row.source as MemorySourceKind,
      createdAt: row.createdAt.getTime(),
    }));
  }
  public async findPromptSources(memoryIds: readonly string[]): Promise<readonly MemorySource[]> {
    if (!memoryIds.length) return [];
    const rows = await this.database.select().from(schema.memorySources).where(and(
      inArray(schema.memorySources.memoryId, [...memoryIds]),
      inArray(schema.memorySources.memoryId, this.database.select({ id: schema.memories.id }).from(schema.memories)
        .where(isNull(schema.memories.moduleId))),
    ))
      .orderBy(desc(schema.memorySources.createdAt)).limit(memoryIds.length * 2);
    return rows.map((row) => ({ ...row, sourceTimestampMs: row.sourceTimestamp?.getTime() ?? null,
      sourceChannelMode: row.sourceChannelMode as ChannelMemoryMode | null, source: row.source as MemorySourceKind, createdAt: row.createdAt.getTime() }));
  }

  public async listBySubject(guildId: string, userId: string): Promise<Memory[]> {
    const rows = await this.database.select().from(schema.memories).where(and(
      eq(schema.memories.guildId, guildId), eq(schema.memories.subjectType, "member"), eq(schema.memories.subjectId, userId),
      or(eq(schema.memories.status, "active"), eq(schema.memories.status, "candidate")),
    ));
    return rows.map(toMemory);
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
        if (query.supportingSourceIds?.length) {
          const derived = await transaction.select({ id: schema.memories.id }).from(schema.memories).where(and(
            eq(schema.memories.guildId, query.guildId),
            sql`exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${schema.memories.structuredValue}->'supportingSourceMessageIds') = 'array' then ${schema.memories.structuredValue}->'supportingSourceMessageIds' else '[]'::jsonb end) as source(value) where value in (${sql.join(query.supportingSourceIds.map((id) => sql`${id}`), sql`, `)}))`,
          ));
          ids.push(...derived.map((row) => row.id));
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
        query.subjectId ? sql`exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${schema.memories.structuredValue}->'supportingSubjects') = 'array' then ${schema.memories.structuredValue}->'supportingSubjects' else '[]'::jsonb end) as subject(value) where value = ${query.subjectId})` : undefined,
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
      query.moduleId == null ? isNull(schema.memories.moduleId) : eq(schema.memories.moduleId, query.moduleId),
      eq(schema.memories.guildId, query.guildId),
      eq(schema.memories.subjectType, query.subjectType),
      eq(schema.memories.subjectId, query.subjectId),
      eq(schema.memories.status, "active"),
      query.excludeMemoryId ? ne(schema.memories.id, query.excludeMemoryId) : undefined,
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
    // Module context cannot create ordinary graph edges. In particular,
    // deleting its supporting memory would otherwise SET NULL the FK and
    // make a previously hidden edge visible to generic recall.
    const supportingIds = inputs.flatMap((input) => input.supportingMemoryId ? [input.supportingMemoryId] : []);
    const moduleSources = supportingIds.length ? await this.database.select({ id: schema.memories.id })
      .from(schema.memories).where(and(inArray(schema.memories.id, supportingIds), isNotNull(schema.memories.moduleId))) : [];
    const blocked = new Set(moduleSources.map((memory) => memory.id));
    inputs = inputs.filter((input) => input.supportingMemoryId === null || !blocked.has(input.supportingMemoryId));
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
        notExists(this.database.select({ id: schema.memories.id }).from(schema.memories).where(and(
          eq(schema.memories.id, schema.memoryRelations.supportingMemoryId),
          isNotNull(schema.memories.moduleId),
        ))),
        or(inArray(schema.memoryRelations.fromSubjectId, frontier), inArray(schema.memoryRelations.toSubjectId, frontier)),
        or(isNull(schema.memoryRelations.isolationChannelId), eq(schema.memoryRelations.isolationChannelId, query.channelId)),
      )).orderBy(asc(schema.memoryRelations.createdAt), asc(schema.memoryRelations.id));
      frontier = collectRelatedSubjects(rows, frontier, hop, querySubjects, visited, results);
    }
    return [...results.values()];
  }
}
