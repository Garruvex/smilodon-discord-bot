import { and, asc, eq, inArray, lt, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type {
  PersonalMemoryExtractionJob,
  PersonalMemoryExtractionJobInput,
  PersonalMemoryExtractionQueueStore,
} from "../../application/context/personal-memory-extraction-queue.js";
import * as schema from "../database/schema.js";

function toJob(row: typeof schema.personalMemoryExtractionJobs.$inferSelect): PersonalMemoryExtractionJob {
  return {
    guildId: row.guildId, channelId: row.channelId, batchId: row.batchId, subjectId: row.subjectId,
    displayName: row.displayName, content: row.content, attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.getTime(), lastError: row.lastError,
    status: row.status as PersonalMemoryExtractionJob["status"],
  };
}

const terminalStatuses = ["succeeded", "dead_letter"] as const;

export class PostgresPersonalMemoryExtractionQueueStore implements PersonalMemoryExtractionQueueStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}
  public initialize(): Promise<void> { return Promise.resolve(); }

  public async enqueueMany(jobs: readonly PersonalMemoryExtractionJobInput[], now: number): Promise<void> {
    if (jobs.length === 0) return;
    const nowDate = new Date(now);
    await this.database.insert(schema.personalMemoryExtractionJobs).values(jobs.map((job) => ({
      guildId: job.guildId, channelId: job.channelId, batchId: job.batchId, subjectId: job.subjectId,
      displayName: job.displayName, content: job.content,
      attempts: 0, nextAttemptAt: nowDate, lastError: null, status: "pending" as const,
      createdAt: nowDate, updatedAt: nowDate,
    }))).onConflictDoNothing();
  }

  public async dequeueDue(limit: number, now: number): Promise<readonly PersonalMemoryExtractionJob[]> {
    const rows = await this.database.select().from(schema.personalMemoryExtractionJobs).where(and(
      eq(schema.personalMemoryExtractionJobs.status, "pending"),
      lte(schema.personalMemoryExtractionJobs.nextAttemptAt, new Date(now)),
    )).orderBy(asc(schema.personalMemoryExtractionJobs.nextAttemptAt)).limit(limit);
    return rows.map(toJob);
  }

  public async markSucceeded(guildId: string, channelId: string, batchId: string, subjectId: string): Promise<void> {
    await this.database.update(schema.personalMemoryExtractionJobs).set({
      status: "succeeded", content: "", lastError: null, updatedAt: new Date(),
    }).where(and(
      eq(schema.personalMemoryExtractionJobs.guildId, guildId), eq(schema.personalMemoryExtractionJobs.channelId, channelId),
      eq(schema.personalMemoryExtractionJobs.batchId, batchId), eq(schema.personalMemoryExtractionJobs.subjectId, subjectId),
    ));
  }

  public async markFailed(
    guildId: string, channelId: string, batchId: string, subjectId: string,
    attempts: number, nextAttemptAt: number, error: string,
  ): Promise<void> {
    await this.database.update(schema.personalMemoryExtractionJobs).set({
      attempts, nextAttemptAt: new Date(nextAttemptAt), lastError: error, updatedAt: new Date(),
    }).where(and(
      eq(schema.personalMemoryExtractionJobs.guildId, guildId), eq(schema.personalMemoryExtractionJobs.channelId, channelId),
      eq(schema.personalMemoryExtractionJobs.batchId, batchId), eq(schema.personalMemoryExtractionJobs.subjectId, subjectId),
    ));
  }

  public async markDeadLettered(guildId: string, channelId: string, batchId: string, subjectId: string, error: string): Promise<void> {
    await this.database.update(schema.personalMemoryExtractionJobs).set({
      status: "dead_letter", content: "", lastError: error, updatedAt: new Date(),
    }).where(and(
      eq(schema.personalMemoryExtractionJobs.guildId, guildId), eq(schema.personalMemoryExtractionJobs.channelId, channelId),
      eq(schema.personalMemoryExtractionJobs.batchId, batchId), eq(schema.personalMemoryExtractionJobs.subjectId, subjectId),
    ));
  }

  public async deleteTerminalForBatch(guildId: string, channelId: string, batchId: string): Promise<void> {
    await this.database.delete(schema.personalMemoryExtractionJobs).where(and(
      eq(schema.personalMemoryExtractionJobs.guildId, guildId), eq(schema.personalMemoryExtractionJobs.channelId, channelId),
      eq(schema.personalMemoryExtractionJobs.batchId, batchId),
      inArray(schema.personalMemoryExtractionJobs.status, terminalStatuses),
    ));
  }

  public async deleteTerminalOlderThan(cutoff: number): Promise<number> {
    const deleted = await this.database.delete(schema.personalMemoryExtractionJobs).where(and(
      inArray(schema.personalMemoryExtractionJobs.status, terminalStatuses),
      lt(schema.personalMemoryExtractionJobs.updatedAt, new Date(cutoff)),
    )).returning({ guildId: schema.personalMemoryExtractionJobs.guildId });
    return deleted.length;
  }

  public async deleteForSubject(guildId: string, subjectId: string): Promise<void> {
    await this.database.delete(schema.personalMemoryExtractionJobs).where(and(
      eq(schema.personalMemoryExtractionJobs.guildId, guildId), eq(schema.personalMemoryExtractionJobs.subjectId, subjectId),
    ));
  }
}
