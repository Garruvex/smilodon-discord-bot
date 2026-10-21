import { hasLegacyRelationshipExpiry } from "./memory-repository-shared.js";
import { memoryClaimProof } from "../../application/memory/memory-claim-provenance.js";
import { memoryRelationProof } from "../../application/memory/memory-relation-provenance.js";
import { randomUUID } from "node:crypto";
import type { ChannelMemoryMode } from "../../application/memory/memory-channel-policy.js";
import { aliasQueryTokens, observedSubjectNames } from "../../application/memory/observed-subject-names.js";

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

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
import * as schema from "../database/sqlite-schema.js";
import {
  assertersOf, authorizedRelationRows, collectRelatedSubjects, maxCandidatesPerIdentity, maxSupersedeChainDepth, retainCallbackMetadata,
} from "./memory-repository-shared.js";

// SQLite has no ANN index — findRecallCandidates does SQL-side authorization
// filtering + bounding only; embedding/BM25 ranking happens in the engine
// (see memory-engine.ts), identically to the Postgres path. This cap is the
// "maximumEligibleVectorScan" ceiling from the plan's SQLite-ceiling section.
const maxEligibleCandidates = 2_000;

function toMemory(row: typeof schema.memories.$inferSelect): Memory {
  return {
    ...(memoryClaimProof(row.contextProvenance, row) ? { contextProvenance: memoryClaimProof(row.contextProvenance, row) } : {}),
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

// Matches exactly the rows sharing one natural identity — see
// MemoryIdentity and the memories_identity index.
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

// See sqlite-chat-state-store.ts's header comment on why every query here
// uses a terminal `.all()`/`.get()`/`.run()` call rather than `await` —
// better-sqlite3's `.transaction()` requires a synchronous callback.
export class SqliteMemoryRepository implements MemoryRepository {
  public findAliasSources(input: CandidateQuery & { message: string }): Promise<readonly Memory[]> {
    const tokens = aliasQueryTokens(input.message); if (!tokens.length) return Promise.resolve([]);
    const matches = this.database.selectDistinct({ id: schema.memories.id, updatedAt: schema.memories.updatedAt })
      .from(schema.memoryObservedAliases).innerJoin(schema.memories, eq(schema.memories.id, schema.memoryObservedAliases.memoryId)).where(and(
        eq(schema.memoryObservedAliases.guildId, input.guildId), eq(schema.memories.guildId, input.guildId), inArray(schema.memoryObservedAliases.alias, tokens),
        eq(schema.memories.subjectType, "member"), eq(schema.memories.status, "active"), isNull(schema.memories.moduleId),
        or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, new Date(input.now))),
        or(isNull(schema.memories.isolationChannelId), eq(schema.memories.isolationChannelId, input.channelId)),
        or(eq(schema.memories.audience, "guild"), and(eq(schema.memories.audience, "channel"), eq(schema.memories.channelId, input.channelId)),
          and(eq(schema.memories.audience, "private"), eq(schema.memories.ownerUserId, input.userId))),
      )).orderBy(desc(schema.memories.updatedAt), asc(schema.memories.id)).limit(129).all();
    if (!matches.length) return Promise.resolve([]);
    return Promise.resolve(this.database.select().from(schema.memories).where(and(eq(schema.memories.guildId, input.guildId), inArray(schema.memories.id, matches.map((row) => row.id))))
      .orderBy(desc(schema.memories.updatedAt), asc(schema.memories.id)).all().map(toMemory));
  }

  public findObservedAliases(input: CandidateQuery & { message: string }): Promise<{ alias: string; subjectId: string }[]> {
    const tokens = aliasQueryTokens(input.message);
    if (!tokens.length) return Promise.resolve([]);
    const rows = this.database.all<{ alias: string; subjectId: string }>(sql`
      SELECT a.alias AS alias, m.subject_id AS subjectId
      FROM memory_observed_aliases a JOIN memories m ON m.id = a.memory_id
      WHERE a.guild_id = ${input.guildId} AND a.alias IN (${sql.join(tokens.map((token) => sql`${token}`), sql`, `)})
        AND m.guild_id = ${input.guildId} AND m.subject_type = 'member' AND m.status = 'active'
        AND m.module_id IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > ${input.now})
        AND (m.isolation_channel_id IS NULL OR m.isolation_channel_id = ${input.channelId})
        AND (m.audience = 'guild' OR (m.audience = 'channel' AND m.channel_id = ${input.channelId})
          OR (m.audience = 'private' AND m.owner_user_id = ${input.userId}))
      GROUP BY alias, m.subject_id LIMIT 512
    `);
    return Promise.resolve(rows);
  }
  public reclassifyPublicMemory(input: { guildId: string; memoryId: string; sourceMessageId: string; sourceChannelId: string;
    assertedByUserId: string; sourceQuote: string; mode: "shared" | "isolated"; sourceTimestampMs?: number; now: number }): Promise<boolean> {
    const changed = this.database.transaction((transaction) => {
      const memory = transaction.select().from(schema.memories).where(and(
        eq(schema.memories.guildId, input.guildId), eq(schema.memories.id, input.memoryId),
        isNull(schema.memories.moduleId),
        eq(schema.memories.audience, "private"), eq(schema.memories.subjectType, "member"),
        eq(schema.memories.subjectId, input.assertedByUserId), eq(schema.memories.ownerUserId, input.assertedByUserId),
      )).get();
      if (!memory) return false;
      const source = transaction.select().from(schema.memorySources).where(and(
        eq(schema.memorySources.memoryId, memory.id), eq(schema.memorySources.sourceMessageId, input.sourceMessageId),
        eq(schema.memorySources.sourceChannelId, input.sourceChannelId), eq(schema.memorySources.assertedByUserId, input.assertedByUserId),
      )).get();
      if (!source) return false;
      const isolated = input.mode === "isolated" || memory.isolationChannelId !== null;
      if (memory.isolationChannelId && memory.isolationChannelId !== input.sourceChannelId) return false;
      transaction.update(schema.memories).set({
        audience: isolated || memory.kind === "episode" ? "channel" : "guild", ownerUserId: null,
        channelId: isolated || memory.kind === "episode" ? input.sourceChannelId : null,
        isolationChannelId: isolated ? input.sourceChannelId : null, updatedAt: new Date(input.now),
      }).where(eq(schema.memories.id, memory.id)).run();
      transaction.update(schema.memorySources).set({ sourceQuote: input.sourceQuote, sourceChannelMode: input.mode,
        sourceTimestamp: input.sourceTimestampMs === undefined ? source.sourceTimestamp : new Date(input.sourceTimestampMs) })
        .where(eq(schema.memorySources.id, source.id)).run();
      return true;
    });
    return Promise.resolve(changed);
  }
  public recordForgetCutoff(input: { guildId: string; subjectId: string; topic: string; slot: string; scopeKey: string; cutoff: number }): Promise<void> {
    this.database.insert(schema.memoryForgetCutoffs).values({ ...input, cutoff: new Date(input.cutoff) }).onConflictDoUpdate({
      target: [schema.memoryForgetCutoffs.guildId, schema.memoryForgetCutoffs.subjectId, schema.memoryForgetCutoffs.topic, schema.memoryForgetCutoffs.slot, schema.memoryForgetCutoffs.scopeKey],
      set: { cutoff: new Date(input.cutoff) },
    }).run(); return Promise.resolve();
  }

  public isSourceForgotten(input: { guildId: string; subjectId: string; topic: string; slot: string; channelId: string; sourceTimestampMs: number }): Promise<boolean> {
    const rows = this.database.select().from(schema.memoryForgetCutoffs).where(and(
      eq(schema.memoryForgetCutoffs.guildId, input.guildId), eq(schema.memoryForgetCutoffs.subjectId, input.subjectId),
      or(eq(schema.memoryForgetCutoffs.scopeKey, "*"), eq(schema.memoryForgetCutoffs.scopeKey, input.channelId)),
      or(eq(schema.memoryForgetCutoffs.topic, "*"), eq(schema.memoryForgetCutoffs.topic, input.topic)),
      or(eq(schema.memoryForgetCutoffs.slot, "*"), eq(schema.memoryForgetCutoffs.slot, input.slot)),
    )).all();
    return Promise.resolve(rows.some((row) => row.cutoff.getTime() >= input.sourceTimestampMs));
  }
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}

  public ingest(input: RepositoryIngestInput): Promise<Memory> {
    if (input.moduleId != null && !/^[a-z][a-z0-9.-]{0,63}$/.test(input.moduleId)) {
      throw new Error("Invalid memory module ID");
    }
    const result = this.database.transaction((transaction) => {
      const identity = identityCondition(input);
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
      let row: typeof schema.memories.$inferSelect;
      if (existing && !isRevision) {
        row = transaction.update(schema.memories).set({
          statement: input.statement,
          contextProvenance: memoryClaimProof(input.contextProvenance, input) ?? memoryClaimProof(existing.contextProvenance, input),
          structuredValue: retainCallbackMetadata(existing.structuredValue, input.structuredValue ?? null, false, input.now),
          // Never lowered by a restatement: most proposers don't rate
          // importance at all (an unrated proposal arrives as 1), so taking
          // the incoming value would let any casual repeat of a fact the
          // extraction pass rated high silently demote it.
          importance: Math.max(existing.importance, input.importance),
          embedding: input.embedding ? [...input.embedding] : null,
          embeddingModel: input.embeddingModel,
          updatedAt: new Date(input.now),
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        }).where(eq(schema.memories.id, existing.id)).returning().get()!;
      } else {
        const newId = randomUUID();
        // Close out the old row BEFORE inserting its replacement — the
        // memories_identity index allows only one active row per identity.
        if (existing && isRevision) {
          transaction.update(schema.memories).set({
            status: "superseded",
            supersededById: newId,
            validUntil: new Date(input.now),
            updatedAt: new Date(input.now),
          }).where(eq(schema.memories.id, existing.id)).run();
        }
        row = transaction.insert(schema.memories).values({
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
          contextProvenance: memoryClaimProof(input.contextProvenance, input),
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
        }).returning().get();
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
          sourceQuote: input.sourceQuote ?? null,
          sourceTimestamp: input.sourceTimestampMs === undefined || input.sourceTimestampMs === null ? null : new Date(input.sourceTimestampMs),
          sourceChannelMode: input.sourceChannelMode ?? null,
          sourceMessageId: input.sourceMessageId,
          sourceChannelId: input.sourceChannelId,
          assertedByUserId: input.assertedByUserId,
          statement: input.statement,
          source: input.source,
          createdAt: new Date(input.now),
        }).run();
      }
      transaction.delete(schema.memoryObservedAliases).where(eq(schema.memoryObservedAliases.memoryId, row.id)).run();
      const aliases = [...new Set(observedSubjectNames(toMemory(row)).map((name) => name.value.toLowerCase()).filter((name) => name.length >= 2))];
      if (aliases.length) transaction.insert(schema.memoryObservedAliases).values(aliases.map((alias) => ({ guildId: row.guildId, memoryId: row.id, alias }))).run();
      return row;
    });
    return Promise.resolve(toMemory(result));
  }

  public findRecallCandidates(query: CandidateQuery): Promise<RecallCandidates> {
    return this.selectCandidates(query, null);
  }
  public migrateRelationshipExpiries(guildId: string): Promise<number> {
    const rows = this.database.select().from(schema.memories).where(and(eq(schema.memories.guildId, guildId), eq(schema.memories.moduleId, "relationships"), eq(schema.memories.status, "active"), isNotNull(schema.memories.expiresAt))).all();
    let count = 0;
    for (const row of rows) {
      if (!hasLegacyRelationshipExpiry(toMemory(row))) continue;
      const result = this.database.update(schema.memories).set({ expiresAt: null }).where(and(eq(schema.memories.id, row.id), eq(schema.memories.status, "active"), eq(schema.memories.updatedAt, row.updatedAt), eq(schema.memories.expiresAt, row.expiresAt!), eq(schema.memories.structuredValue, row.structuredValue))).run();
      count += result.changes;
    }
    return Promise.resolve(count);
  }
  public findModuleCandidates(query: CandidateQuery & { moduleId: string }): Promise<RecallCandidates> {
    return this.selectCandidates(query, query.moduleId);
  }
  public async deleteExpiredModuleData(guildId: string, now: number, historyDays: number): Promise<number> {
    await this.migrateRelationshipExpiries(guildId);
    return Promise.resolve(this.database.delete(schema.memories).where(and(eq(schema.memories.guildId, guildId), isNotNull(schema.memories.moduleId),
      or(and(isNotNull(schema.memories.expiresAt), lte(schema.memories.expiresAt, new Date(now))),
        and(ne(schema.memories.status, "active"), lte(schema.memories.updatedAt, new Date(now - historyDays * 86_400_000)))))).run().changes);
  }
  public clearModuleData(guildId: string, moduleId: string): Promise<number> {
    return Promise.resolve(this.database.delete(schema.memories).where(and(eq(schema.memories.guildId, guildId), eq(schema.memories.moduleId, moduleId))).run().changes);
  }
  public compareAndSetStructuredValue(input: { guildId: string; memoryId: string; updatedAt: number; expected: unknown; value: unknown }): Promise<boolean> {
    const result = this.database.update(schema.memories).set({ structuredValue: input.value }).where(and(
      eq(schema.memories.guildId, input.guildId), eq(schema.memories.id, input.memoryId), eq(schema.memories.status, "active"),
      eq(schema.memories.updatedAt, new Date(input.updatedAt)),
      input.expected == null ? isNull(schema.memories.structuredValue) : eq(schema.memories.structuredValue, input.expected),
    )).run();
    return Promise.resolve(result.changes === 1);
  }
  public claimCallbackMemory(input: { guildId: string; memoryId: string; updatedAt: number; expected: unknown; value: unknown; maxPerDay: number; dayStart: number; now: number }): Promise<boolean> {
    return Promise.resolve(this.database.transaction((transaction) => {
      const count = transaction.select({ count: sql<number>`count(distinct json_extract(${schema.memories.structuredValue}, '$.callback.attemptId'))` }).from(schema.memories).where(and(
        eq(schema.memories.guildId, input.guildId), ne(schema.memories.id, input.memoryId),
        sql`json_extract(${schema.memories.structuredValue}, '$.callback.quotaDayStart') >= ${input.dayStart}`,
        sql`(json_extract(${schema.memories.structuredValue}, '$.callback.status') in ('sending', 'delivered', 'uncertain') or
          (json_extract(${schema.memories.structuredValue}, '$.callback.status') = 'claimed' and json_extract(${schema.memories.structuredValue}, '$.callback.leaseUntil') > ${input.now}))`,
      )).get()?.count ?? 0;
      if (count >= input.maxPerDay) return false;
      const result = transaction.update(schema.memories).set({ structuredValue: input.value }).where(and(
        eq(schema.memories.guildId, input.guildId), eq(schema.memories.id, input.memoryId), eq(schema.memories.status, "active"),
        eq(schema.memories.updatedAt, new Date(input.updatedAt)),
        input.expected == null ? isNull(schema.memories.structuredValue) : eq(schema.memories.structuredValue, input.expected),
      )).run();
      return result.changes === 1;
    }));
  }
  public findDueCallbackCandidates(query: CandidateQuery): Promise<RecallCandidates> { return this.selectCandidates(query, null, true); }
  private selectCandidates(query: CandidateQuery, moduleId: string | null, dueCallbacks = false): Promise<RecallCandidates> {
    // subjectIds, when given, is applied in SQL alongside the other filters
    // — not as a post-fetch JS filter — so it narrows what the LIMIT below
    // bounds rather than being applied after it. Filtering after a LIMIT
    // would silently drop a requested subject's memories whenever the
    // unfiltered eligible set exceeds maxEligibleCandidates and happens to
    // sort the requested subject's rows past the cutoff.
    //
    // ORDER BY matters here for the same reason: without one, which rows
    // survive the LIMIT once a guild's eligible set exceeds
    // maxEligibleCandidates is implementation-defined (in practice, rowid/
    // insertion order) — meaning newly-written, usually most-relevant
    // memories could be silently excluded from ranking entirely while old
    // ones always win. Ordering subject-matches first, then most-recently-
    // updated, means the cap always drops the least-likely-relevant rows
    // first instead of an arbitrary set.
    // Bare integer literals here would be misread by SQLite as ORDER-BY
    // column-position references (e.g. a literal 0/1 term means "order by
    // the Nth selected column", not "order by this constant") — so the
    // subject-priority term is only added to the ORDER BY at all when
    // there's a real expression to rank by, never as a dummy placeholder.
    // Ordered on prioritySubjectIds, NOT subjectIds — the latter already
    // narrows the WHERE clause below, so every row that reaches ORDER BY
    // already matches it and a priority term keyed on it would be inert.
    const orderByTerms = query.prioritySubjectIds && query.prioritySubjectIds.length > 0
      ? [sql`case when ${inArray(schema.memories.subjectId, [...query.prioritySubjectIds])} then 0 else 1 end`, desc(schema.memories.updatedAt)]
      : [desc(schema.memories.updatedAt)];
    const rows = this.database.select().from(schema.memories).where(and(
      eq(schema.memories.guildId, query.guildId),
      moduleId === null ? isNull(schema.memories.moduleId) : eq(schema.memories.moduleId, moduleId),
      dueCallbacks ? sql`json_extract(${schema.memories.structuredValue}, '$.callback.dueAt') <= ${query.now}
        and json_extract(${schema.memories.structuredValue}, '$.callback.nextAttemptAt') <= ${query.now}
        and json_extract(${schema.memories.structuredValue}, '$.callback.expiresAt') > ${query.now}
        and json_extract(${schema.memories.structuredValue}, '$.callback.status') in ('pending', 'claimed', 'sending')` : undefined,
      eq(schema.memories.status, "active"),
      or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, new Date(query.now))),
      or(isNull(schema.memories.isolationChannelId), eq(schema.memories.isolationChannelId, query.channelId)),
      or(
        and(eq(schema.memories.audience, "private"), eq(schema.memories.ownerUserId, query.userId)),
        and(eq(schema.memories.audience, "channel"), eq(schema.memories.channelId, query.channelId)),
        eq(schema.memories.audience, "guild"),
      ),
      query.subjectIds && query.subjectIds.length > 0 ? inArray(schema.memories.subjectId, [...query.subjectIds]) : undefined,
    )).orderBy(...orderByTerms).limit(maxEligibleCandidates).all();
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

  public findSources(memoryId: string): Promise<readonly MemorySource[]> {
    const rows = this.database.select().from(schema.memorySources)
      .where(eq(schema.memorySources.memoryId, memoryId))
      .orderBy(asc(schema.memorySources.createdAt))
      .all();
    return Promise.resolve(rows.map((row) => ({
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
    })));
  }
  public findPromptSources(memoryIds: readonly string[]): Promise<readonly MemorySource[]> {
    if (!memoryIds.length) return Promise.resolve([]);
    const rows = this.database.select().from(schema.memorySources).where(and(
      inArray(schema.memorySources.memoryId, [...memoryIds]),
      inArray(schema.memorySources.memoryId, this.database.select({ id: schema.memories.id }).from(schema.memories)
        .where(isNull(schema.memories.moduleId))),
    ))
      .orderBy(desc(schema.memorySources.createdAt)).limit(memoryIds.length * 2).all();
    return Promise.resolve(rows.map((row) => ({ ...row, sourceTimestampMs: row.sourceTimestamp?.getTime() ?? null,
      sourceChannelMode: row.sourceChannelMode as ChannelMemoryMode | null, source: row.source as MemorySourceKind, createdAt: row.createdAt.getTime() })));
  }

  public listBySubject(guildId: string, userId: string): Promise<Memory[]> {
    const rows = this.database.select().from(schema.memories).where(and(
      eq(schema.memories.guildId, guildId), eq(schema.memories.subjectType, "member"), eq(schema.memories.subjectId, userId),
      or(eq(schema.memories.status, "active"), eq(schema.memories.status, "candidate")),
    )).all();
    return Promise.resolve(rows.map(toMemory));
  }

  // memory_sources rows go with their memory via ON DELETE CASCADE
  // (better-sqlite3 enables foreign keys by default).
  public forget(query: ForgetQuery): Promise<number> {
    return Promise.resolve(this.database.transaction((transaction) => {
      if (query.memoryId) {
        const target = transaction.select().from(schema.memories).where(and(
          eq(schema.memories.guildId, query.guildId), eq(schema.memories.id, query.memoryId),
          query.ownerUserId ? eq(schema.memories.ownerUserId, query.ownerUserId) : undefined,
        )).get();
        if (!target) return 0;
        // Walk back through supersededById: every earlier version of this
        // fact (same-identity revisions and conflict-superseded restatements
        // alike) goes with it. Confined to the target's owner, the same
        // scope both supersede paths already stay within.
        const ids = [target.id];
        let frontier = [target.id];
        for (let depth = 0; depth < maxSupersedeChainDepth && frontier.length > 0; depth++) {
          frontier = transaction.select({ id: schema.memories.id }).from(schema.memories).where(and(
            eq(schema.memories.guildId, query.guildId),
            eq(schema.memories.status, "superseded"),
            inArray(schema.memories.supersededById, frontier),
            target.ownerUserId === null ? isNull(schema.memories.ownerUserId) : eq(schema.memories.ownerUserId, target.ownerUserId),
          )).all().map((row) => row.id).filter((id) => !ids.includes(id));
          ids.push(...frontier);
        }
        if (query.supportingSourceIds?.length) {
          const derived = transaction.select({ id: schema.memories.id }).from(schema.memories).where(and(
            eq(schema.memories.guildId, query.guildId),
            sql`exists (select 1 from json_each(case when json_type(${schema.memories.structuredValue}, '$.supportingSourceMessageIds') = 'array' then json_extract(${schema.memories.structuredValue}, '$.supportingSourceMessageIds') else '[]' end) where value in (${sql.join(query.supportingSourceIds.map((id) => sql`${id}`), sql`, `)}))`,
          )).all();
          ids.push(...derived.map((row) => row.id));
        }
        return transaction.delete(schema.memories).where(inArray(schema.memories.id, ids)).run().changes;
      }
      // OR, not AND — see PostgresMemoryRepository.forget/ForgetQuery.subjectId
      // for why: a "forget everything about this user" caller needs either
      // condition to catch a row.
      const conditions = [
        query.ownerUserId ? eq(schema.memories.ownerUserId, query.ownerUserId) : undefined,
        query.subjectId ? and(eq(schema.memories.subjectType, "member"), eq(schema.memories.subjectId, query.subjectId)) : undefined,
        query.subjectId ? sql`exists (select 1 from json_each(case when json_type(${schema.memories.structuredValue}, '$.supportingSubjects') = 'array' then json_extract(${schema.memories.structuredValue}, '$.supportingSubjects') else '[]' end) where value = ${query.subjectId})` : undefined,
      ].filter((condition) => condition !== undefined);
      let removed = conditions.length > 0
        ? transaction.delete(schema.memories).where(and(eq(schema.memories.guildId, query.guildId), or(...conditions))).run().changes
        : 0;
      if (query.subjectId) {
        transaction.delete(schema.memoryRelations).where(and(
          eq(schema.memoryRelations.guildId, query.guildId),
          or(
            and(eq(schema.memoryRelations.fromSubjectType, "member"), eq(schema.memoryRelations.fromSubjectId, query.subjectId)),
            and(eq(schema.memoryRelations.toSubjectType, "member"), eq(schema.memoryRelations.toSubjectId, query.subjectId)),
          ),
        )).run();
      }
      if (query.assertedByUserId) {
        const touched = transaction.selectDistinct({ id: schema.memories.id }).from(schema.memorySources)
          .innerJoin(schema.memories, eq(schema.memories.id, schema.memorySources.memoryId))
          .where(and(eq(schema.memories.guildId, query.guildId), eq(schema.memorySources.assertedByUserId, query.assertedByUserId)))
          .all().map((row) => row.id);
        if (touched.length > 0) {
          transaction.delete(schema.memorySources).where(and(
            inArray(schema.memorySources.memoryId, touched), eq(schema.memorySources.assertedByUserId, query.assertedByUserId),
          )).run();
          removed += transaction.delete(schema.memories).where(and(
            inArray(schema.memories.id, touched), eq(schema.memories.status, "candidate"),
            notExists(transaction.select({ id: schema.memorySources.id }).from(schema.memorySources)
              .where(eq(schema.memorySources.memoryId, schema.memories.id))),
          )).run().changes;
        }
      }
      return removed;
    }));
  }

  public deleteExpiredCandidates(guildId: string, now: number): Promise<number> {
    const result = this.database.delete(schema.memories).where(and(
      eq(schema.memories.guildId, guildId), eq(schema.memories.status, "candidate"),
      isNotNull(schema.memories.expiresAt), lte(schema.memories.expiresAt, new Date(now)),
    )).run();
    return Promise.resolve(result.changes);
  }

  public findCandidatesByIdentity(query: CandidateIdentityQuery): Promise<readonly CandidateWithAsserters[]> {
    const rows = this.database.select().from(schema.memories).where(and(
      identityCondition(query),
      eq(schema.memories.status, "candidate"),
      ne(schema.memories.id, query.excludeMemoryId),
      or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, new Date(query.now))),
    )).limit(maxCandidatesPerIdentity).all();
    if (rows.length === 0) return Promise.resolve([]);
    const sources = this.database.select({ memoryId: schema.memorySources.memoryId, assertedByUserId: schema.memorySources.assertedByUserId })
      .from(schema.memorySources)
      .where(inArray(schema.memorySources.memoryId, rows.map((row) => row.id))).all();
    return Promise.resolve(rows.map((row) => ({ memory: toMemory(row), assertedByUserIds: assertersOf(row.id, sources) })));
  }

  public promoteCandidate(command: PromoteCandidateCommand): Promise<Memory | null> {
    const result = this.database.transaction((transaction) => {
      const target = transaction.select().from(schema.memories).where(and(
        eq(schema.memories.guildId, command.guildId), eq(schema.memories.id, command.memoryId),
        eq(schema.memories.status, "candidate"),
      )).get();
      if (!target) return null;
      const contextProvenance = memoryClaimProof(command.contextProvenance, target);
      if (command.contextProvenance && !contextProvenance) return null;
      const identity = identityCondition(toMemory(target));
      const active = transaction.select({ id: schema.memories.id }).from(schema.memories)
        .where(and(identity, eq(schema.memories.status, "active"))).get();
      if (active) return null;
      const absorbed = command.absorbedMemoryIds.length > 0
        ? transaction.select({ id: schema.memories.id }).from(schema.memories).where(and(
            identity, eq(schema.memories.status, "candidate"),
            inArray(schema.memories.id, [...command.absorbedMemoryIds]), ne(schema.memories.id, target.id),
          )).all().map((row) => row.id)
        : [];
      if (absorbed.length > 0) {
        transaction.update(schema.memorySources).set({ memoryId: target.id })
          .where(inArray(schema.memorySources.memoryId, absorbed)).run();
        transaction.delete(schema.memories).where(inArray(schema.memories.id, absorbed)).run();
      }
      return transaction.update(schema.memories).set({
        contextProvenance,
        status: "active", expiresAt: null, validFrom: new Date(command.now), updatedAt: new Date(command.now),
      }).where(eq(schema.memories.id, target.id)).returning().get() ?? null;
    });
    return Promise.resolve(result ? toMemory(result) : null);
  }

  // See PostgresMemoryRepository.findActiveBySubject for the bound rationale.
  public findActiveBySubject(query: ActiveSubjectQuery): Promise<readonly Memory[]> {
    const rows = this.database.select().from(schema.memories).where(and(
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

  public createRelations(inputs: readonly RelationCreateInput[]): Promise<number> {
    if (inputs.length === 0) return Promise.resolve(0);
    // Never let module context create ordinary graph edges that could
    // become visible when deletion clears their supporting-memory FK.
    const supportingIds = inputs.flatMap((input) => input.supportingMemoryId ? [input.supportingMemoryId] : []);
    const moduleSources = supportingIds.length ? this.database.select({ id: schema.memories.id })
      .from(schema.memories).where(and(inArray(schema.memories.id, supportingIds), isNotNull(schema.memories.moduleId))).all() : [];
    const blocked = new Set(moduleSources.map((memory) => memory.id));
    inputs = inputs.filter((input) => input.supportingMemoryId === null || !blocked.has(input.supportingMemoryId));
    if (inputs.length === 0) return Promise.resolve(0);
    for (const input of inputs) {
      const proof = memoryRelationProof(input.contextProvenance, input); if (!proof) continue;
      this.database.update(schema.memoryRelations).set({ contextProvenance: proof, supportingMemoryId: input.supportingMemoryId }).where(and(
        eq(schema.memoryRelations.guildId, input.guildId), eq(schema.memoryRelations.fromSubjectType, input.fromSubjectType), eq(schema.memoryRelations.fromSubjectId, input.fromSubjectId),
        eq(schema.memoryRelations.toSubjectType, input.toSubjectType), eq(schema.memoryRelations.toSubjectId, input.toSubjectId),
        eq(schema.memoryRelations.predicate, input.predicate), eq(schema.memoryRelations.kind, input.kind),
        input.channelId == null ? isNull(schema.memoryRelations.channelId) : eq(schema.memoryRelations.channelId, input.channelId),
        input.isolationChannelId === null ? isNull(schema.memoryRelations.isolationChannelId) : eq(schema.memoryRelations.isolationChannelId, input.isolationChannelId),
      )).run();
    }
    // ON CONFLICT DO NOTHING against memory_relations_identity — re-extracting
    // a known edge is a no-op, not a duplicate row.
    const result = this.database.insert(schema.memoryRelations).values(inputs.map((input) => ({
      channelId: input.channelId ?? null, contextProvenance: memoryRelationProof(input.contextProvenance, input),
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
    }))).onConflictDoNothing().run();
    return Promise.resolve(result.changes);
  }

  // See PostgresMemoryRepository.findRelatedSubjects for the BFS rationale
  // (bounded iterative, not a recursive SQL CTE).
  public async findRelatedSubjects(query: RelatedSubjectsQuery): Promise<readonly RelatedSubject[]> {
    const querySubjects = new Set(query.subjectIds);
    const visited = new Set<string>(query.subjectIds);
    const results = new Map<string, RelatedSubject>();
    let frontier = [...query.subjectIds];
    for (let hop = 1; hop <= query.maxHops && frontier.length > 0; hop++) {
      const rows = this.database.select().from(schema.memoryRelations).where(and(
        eq(schema.memoryRelations.guildId, query.guildId),
        or(isNull(schema.memoryRelations.channelId), eq(schema.memoryRelations.channelId, query.channelId)),
        query.context ? and(eq(schema.memoryRelations.channelId, query.channelId), isNotNull(schema.memoryRelations.contextProvenance)) : undefined,
        notExists(this.database.select({ id: schema.memories.id }).from(schema.memories).where(and(
          eq(schema.memories.id, schema.memoryRelations.supportingMemoryId),
          isNotNull(schema.memories.moduleId),
        ))),
        or(inArray(schema.memoryRelations.fromSubjectId, frontier), inArray(schema.memoryRelations.toSubjectId, frontier)),
        or(isNull(schema.memoryRelations.isolationChannelId), eq(schema.memoryRelations.isolationChannelId, query.channelId)),
      )).orderBy(asc(schema.memoryRelations.createdAt), asc(schema.memoryRelations.id)).limit(256).all();
      const allowed = await authorizedRelationRows(rows, query, (id) => this.findById(query.guildId, id));
      frontier = collectRelatedSubjects(allowed, frontier, hop, querySubjects, visited, results);
    }
    return Promise.resolve([...results.values()]);
  }
}
