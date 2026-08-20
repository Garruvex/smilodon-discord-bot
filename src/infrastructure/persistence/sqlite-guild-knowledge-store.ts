import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { z } from "zod";

import type { GuildKnowledgeRecord } from "../../application/chat/chat-provider.js";
import { guildKnowledgeLimits, maySelfConfirm } from "../../application/chat/guild-knowledge-policy.js";
import type { GuildKnowledgeStore } from "../../application/chat/guild-knowledge-store.js";
import * as schema from "../database/sqlite-schema.js";

const userIdsSchema = z.array(z.string());
const subjectTypeSchema = z.enum(["guild", "member", "team", "project"]);
const sourceSchema = z.enum(["self_report", "community", "administrator", "consolidation"]);

// See sqlite-chat-state-store.ts's header comment on why every query here
// uses a terminal `.all()`/`.get()`/`.run()` call rather than `await` —
// better-sqlite3's `.transaction()` requires a synchronous callback.
export class SqliteGuildKnowledgeStore implements GuildKnowledgeStore {
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}
  public initialize(): Promise<void> { return Promise.resolve(); }

  public loadConfirmed(guildId: string, channelId: string): Promise<readonly GuildKnowledgeRecord[]> {
    const rows = this.database.select().from(schema.guildKnowledge).where(and(
      eq(schema.guildKnowledge.guildId, guildId), eq(schema.guildKnowledge.status, "confirmed"),
      or(isNull(schema.guildKnowledge.channelId), eq(schema.guildKnowledge.channelId, channelId)),
    )).orderBy(desc(schema.guildKnowledge.updatedAt)).limit(guildKnowledgeLimits.maxConfirmedRecords).all();
    const bounded: GuildKnowledgeRecord[] = [];
    let serializedChars = 0;
    for (const row of rows) {
      const promptFields = {
        id: row.id, subjectType: subjectTypeSchema.parse(row.subjectType), subjectId: row.subjectId,
        topic: row.topic, slot: row.slot, statement: row.statement, source: sourceSchema.parse(row.source),
        updatedAt: row.updatedAt.getTime(),
      };
      // `embedding` excluded from the size calculation — it's never sent to
      // the model, so it must not count against maxSerializedChars.
      const size = JSON.stringify(promptFields).length;
      if (serializedChars + size > guildKnowledgeLimits.maxSerializedChars) break;
      bounded.push({ ...promptFields, embedding: row.embedding ?? null });
      serializedChars += size;
    }
    return Promise.resolve(bounded);
  }

  public propose(input: Parameters<GuildKnowledgeStore["propose"]>[0]): Promise<void> {
    if (input.candidates.length === 0) return Promise.resolve();
    this.database.transaction((transaction) => {
      for (const candidate of input.candidates) {
        const identity = and(
          eq(schema.guildKnowledge.guildId, input.guildId),
          candidate.channelId === null
            ? isNull(schema.guildKnowledge.channelId)
            : eq(schema.guildKnowledge.channelId, candidate.channelId),
          eq(schema.guildKnowledge.subjectType, candidate.subjectType),
          eq(schema.guildKnowledge.subjectId, candidate.subjectId),
          eq(schema.guildKnowledge.topic, candidate.topic),
          eq(schema.guildKnowledge.slot, candidate.slot),
        );
        const existing = transaction.select().from(schema.guildKnowledge).where(identity).get();
        const selfConfirmed = maySelfConfirm(candidate, input.assertedByUserId);
        if (existing) {
          const assertedBy = userIdsSchema.parse(existing.assertedByUserIds);
          const confirmedBy = userIdsSchema.parse(existing.confirmedByUserIds);
          if (input.assertedByUserId !== null && !assertedBy.includes(input.assertedByUserId)) assertedBy.push(input.assertedByUserId);
          if (selfConfirmed && input.assertedByUserId !== null && !confirmedBy.includes(input.assertedByUserId)) confirmedBy.push(input.assertedByUserId);
          const statementChanged = selfConfirmed || existing.statement === candidate.statement;
          transaction.update(schema.guildKnowledge).set({
            statement: statementChanged ? candidate.statement : existing.statement,
            embedding: statementChanged ? candidate.embedding : existing.embedding,
            status: selfConfirmed ? "confirmed" : existing.status,
            source: selfConfirmed ? "self_report" : existing.source,
            assertedByUserIds: assertedBy,
            confirmedByUserIds: confirmedBy,
            expiresAt: selfConfirmed ? null : existing.expiresAt,
            updatedAt: new Date(input.now),
          }).where(eq(schema.guildKnowledge.id, existing.id)).run();
          continue;
        }
        const confirmedCount = transaction.select().from(schema.guildKnowledge).where(and(
          eq(schema.guildKnowledge.guildId, input.guildId), eq(schema.guildKnowledge.status, "confirmed"),
        )).all().length;
        const candidateCount = transaction.select().from(schema.guildKnowledge).where(and(
          eq(schema.guildKnowledge.guildId, input.guildId), eq(schema.guildKnowledge.status, "candidate"),
          or(isNull(schema.guildKnowledge.expiresAt), gt(schema.guildKnowledge.expiresAt, new Date(input.now))),
        )).all().length;
        if (selfConfirmed && confirmedCount >= guildKnowledgeLimits.maxConfirmedRecords) continue;
        if (!selfConfirmed && candidateCount >= guildKnowledgeLimits.maxCandidateRecords) continue;
        transaction.insert(schema.guildKnowledge).values({
          id: randomUUID(), guildId: input.guildId, channelId: candidate.channelId, subjectType: candidate.subjectType,
          subjectId: candidate.subjectId, topic: candidate.topic, slot: candidate.slot,
          statement: candidate.statement, embedding: candidate.embedding,
          status: selfConfirmed ? "confirmed" : "candidate",
          source: selfConfirmed ? "self_report" : input.assertedByUserId === null ? "consolidation" : "community",
          assertedByUserIds: input.assertedByUserId === null ? [] : [input.assertedByUserId],
          confirmedByUserIds: selfConfirmed && input.assertedByUserId !== null ? [input.assertedByUserId] : [],
          expiresAt: selfConfirmed ? null : new Date(input.now + guildKnowledgeLimits.candidateTtlMs),
          createdAt: new Date(input.now), updatedAt: new Date(input.now),
        }).onConflictDoNothing().run();
      }
    });
    return Promise.resolve();
  }
}
