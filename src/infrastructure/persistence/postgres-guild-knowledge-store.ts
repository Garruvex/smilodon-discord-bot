import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { guildKnowledgeLimits, maySelfConfirm } from "../../application/chat/guild-knowledge-policy.js";
import type { GuildKnowledgeRecord } from "../../application/chat/chat-provider.js";
import type { GuildKnowledgeStore } from "../../application/chat/guild-knowledge-store.js";
import * as schema from "../database/schema.js";

const userIdsSchema = z.array(z.string());
const subjectTypeSchema = z.enum(["guild", "member", "team", "project"]);
const sourceSchema = z.enum(["self_report", "community", "administrator"]);

export class PostgresGuildKnowledgeStore implements GuildKnowledgeStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}
  public initialize(): Promise<void> { return Promise.resolve(); }

  public async loadConfirmed(guildId: string): Promise<readonly GuildKnowledgeRecord[]> {
    const rows = await this.database.select().from(schema.guildKnowledge).where(and(
      eq(schema.guildKnowledge.guildId, guildId), eq(schema.guildKnowledge.status, "confirmed"),
    )).orderBy(desc(schema.guildKnowledge.updatedAt)).limit(guildKnowledgeLimits.maxConfirmedRecords);
    const bounded: GuildKnowledgeRecord[] = [];
    let serializedChars = 0;
    for (const row of rows) {
      const record: GuildKnowledgeRecord = {
        id: row.id, subjectType: subjectTypeSchema.parse(row.subjectType), subjectId: row.subjectId,
        topic: row.topic, slot: row.slot, statement: row.statement, source: sourceSchema.parse(row.source),
        updatedAt: row.updatedAt.getTime(),
      };
      const size = JSON.stringify(record).length;
      if (serializedChars + size > guildKnowledgeLimits.maxSerializedChars) break;
      bounded.push(record);
      serializedChars += size;
    }
    return bounded;
  }

  public async propose(input: Parameters<GuildKnowledgeStore["propose"]>[0]): Promise<void> {
    if (input.candidates.length === 0) return;
    await this.database.transaction(async (transaction) => {
      for (const candidate of input.candidates) {
        const identity = and(
          eq(schema.guildKnowledge.guildId, input.guildId),
          eq(schema.guildKnowledge.subjectType, candidate.subjectType),
          eq(schema.guildKnowledge.subjectId, candidate.subjectId),
          eq(schema.guildKnowledge.topic, candidate.topic),
          eq(schema.guildKnowledge.slot, candidate.slot),
        );
        const existingRows = await transaction.select().from(schema.guildKnowledge).where(identity).limit(1);
        const existing = existingRows[0];
        const selfConfirmed = maySelfConfirm(candidate, input.assertedByUserId);
        if (existing) {
          const assertedBy = userIdsSchema.parse(existing.assertedByUserIds);
          const confirmedBy = userIdsSchema.parse(existing.confirmedByUserIds);
          if (!assertedBy.includes(input.assertedByUserId)) assertedBy.push(input.assertedByUserId);
          if (selfConfirmed && !confirmedBy.includes(input.assertedByUserId)) confirmedBy.push(input.assertedByUserId);
          await transaction.update(schema.guildKnowledge).set({
            statement: selfConfirmed || existing.statement === candidate.statement ? candidate.statement : existing.statement,
            status: selfConfirmed ? "confirmed" : existing.status,
            source: selfConfirmed ? "self_report" : existing.source,
            assertedByUserIds: assertedBy,
            confirmedByUserIds: confirmedBy,
            expiresAt: selfConfirmed ? null : existing.expiresAt,
            updatedAt: new Date(input.now),
          }).where(eq(schema.guildKnowledge.id, existing.id));
          continue;
        }
        const confirmedCount = await transaction.$count(schema.guildKnowledge, and(
          eq(schema.guildKnowledge.guildId, input.guildId), eq(schema.guildKnowledge.status, "confirmed"),
        ));
        const candidateCount = await transaction.$count(schema.guildKnowledge, and(
          eq(schema.guildKnowledge.guildId, input.guildId), eq(schema.guildKnowledge.status, "candidate"),
          or(isNull(schema.guildKnowledge.expiresAt), gt(schema.guildKnowledge.expiresAt, new Date(input.now))),
        ));
        if (selfConfirmed && confirmedCount >= guildKnowledgeLimits.maxConfirmedRecords) continue;
        if (!selfConfirmed && candidateCount >= guildKnowledgeLimits.maxCandidateRecords) continue;
        await transaction.insert(schema.guildKnowledge).values({
          id: randomUUID(), guildId: input.guildId, subjectType: candidate.subjectType,
          subjectId: candidate.subjectId, topic: candidate.topic, slot: candidate.slot,
          statement: candidate.statement, status: selfConfirmed ? "confirmed" : "candidate",
          source: selfConfirmed ? "self_report" : "community",
          assertedByUserIds: [input.assertedByUserId], confirmedByUserIds: selfConfirmed ? [input.assertedByUserId] : [],
          expiresAt: selfConfirmed ? null : new Date(input.now + guildKnowledgeLimits.candidateTtlMs),
          createdAt: new Date(input.now), updatedAt: new Date(input.now),
        }).onConflictDoNothing();
      }
    });
  }
}
