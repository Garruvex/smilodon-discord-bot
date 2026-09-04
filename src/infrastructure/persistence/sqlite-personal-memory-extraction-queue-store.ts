import { and, asc, eq, inArray, lt, lte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type {
  PersonalMemoryExtractionJob,
  PersonalMemoryExtractionJobInput,
  PersonalMemoryExtractionQueueStore,
} from "../../application/context/personal-memory-extraction-queue.js";
import * as schema from "../database/sqlite-schema.js";

function toJob(row: typeof schema.personalMemoryExtractionJobs.$inferSelect): PersonalMemoryExtractionJob {
  return {
    guildId: row.guildId, channelId: row.channelId, batchId: row.batchId, subjectId: row.subjectId,
    displayName: row.displayName, content: row.content, attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.getTime(), lastError: row.lastError,
    status: row.status as PersonalMemoryExtractionJob["status"],
  };
}

const terminalStatuses = ["succeeded", "dead_letter"] as const;

export class SqlitePersonalMemoryExtractionQueueStore implements PersonalMemoryExtractionQueueStore {
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}
  public initialize(): Promise<void> { return Promise.resolve(); }

  public enqueueMany(jobs: readonly PersonalMemoryExtractionJobInput[], now: number): Promise<void> {
    if (jobs.length === 0) return Promise.resolve();
    const nowDate = new Date(now);
    this.database.insert(schema.personalMemoryExtractionJobs).values(jobs.map((job) => ({
      guildId: job.guildId, channelId: job.channelId, batchId: job.batchId, subjectId: job.subjectId,
      displayName: job.displayName, content: job.content,
      attempts: 0, nextAttemptAt: nowDate, lastError: null, status: "pending" as const,
      createdAt: nowDate, updatedAt: nowDate,
    }))).onConflictDoNothing().run();
    return Promise.resolve();
  }

  public dequeueDue(limit: number, now: number): Promise<readonly PersonalMemoryExtractionJob[]> {
    const rows = this.database.select().from(schema.personalMemoryExtractionJobs).where(and(
      eq(schema.personalMemoryExtractionJobs.status, "pending"),
      lte(schema.personalMemoryExtractionJobs.nextAttemptAt, new Date(now)),
    )).orderBy(asc(schema.personalMemoryExtractionJobs.nextAttemptAt)).limit(limit).all();
    return Promise.resolve(rows.map(toJob));
  }

  public markSucceeded(guildId: string, channelId: string, batchId: string, subjectId: string): Promise<void> {
    this.database.update(schema.personalMemoryExtractionJobs).set({
      status: "succeeded", content: "", lastError: null, updatedAt: new Date(),
    }).where(and(
      eq(schema.personalMemoryExtractionJobs.guildId, guildId), eq(schema.personalMemoryExtractionJobs.channelId, channelId),
      eq(schema.personalMemoryExtractionJobs.batchId, batchId), eq(schema.personalMemoryExtractionJobs.subjectId, subjectId),
    )).run();
    return Promise.resolve();
  }

  public markFailed(
    guildId: string, channelId: string, batchId: string, subjectId: string,
    attempts: number, nextAttemptAt: number, error: string,
  ): Promise<void> {
    this.database.update(schema.personalMemoryExtractionJobs).set({
      attempts, nextAttemptAt: new Date(nextAttemptAt), lastError: error, updatedAt: new Date(),
    }).where(and(
      eq(schema.personalMemoryExtractionJobs.guildId, guildId), eq(schema.personalMemoryExtractionJobs.channelId, channelId),
      eq(schema.personalMemoryExtractionJobs.batchId, batchId), eq(schema.personalMemoryExtractionJobs.subjectId, subjectId),
    )).run();
    return Promise.resolve();
  }

  public markDeadLettered(guildId: string, channelId: string, batchId: string, subjectId: string, error: string): Promise<void> {
    this.database.update(schema.personalMemoryExtractionJobs).set({
      status: "dead_letter", content: "", lastError: error, updatedAt: new Date(),
    }).where(and(
      eq(schema.personalMemoryExtractionJobs.guildId, guildId), eq(schema.personalMemoryExtractionJobs.channelId, channelId),
      eq(schema.personalMemoryExtractionJobs.batchId, batchId), eq(schema.personalMemoryExtractionJobs.subjectId, subjectId),
    )).run();
    return Promise.resolve();
  }

  public deleteTerminalForBatch(guildId: string, channelId: string, batchId: string): Promise<void> {
    this.database.delete(schema.personalMemoryExtractionJobs).where(and(
      eq(schema.personalMemoryExtractionJobs.guildId, guildId), eq(schema.personalMemoryExtractionJobs.channelId, channelId),
      eq(schema.personalMemoryExtractionJobs.batchId, batchId),
      inArray(schema.personalMemoryExtractionJobs.status, terminalStatuses),
    )).run();
    return Promise.resolve();
  }

  public deleteTerminalOlderThan(cutoff: number): Promise<number> {
    const result = this.database.delete(schema.personalMemoryExtractionJobs).where(and(
      inArray(schema.personalMemoryExtractionJobs.status, terminalStatuses),
      lt(schema.personalMemoryExtractionJobs.updatedAt, new Date(cutoff)),
    )).run();
    return Promise.resolve(result.changes);
  }

  public deleteForSubject(guildId: string, subjectId: string): Promise<void> {
    this.database.delete(schema.personalMemoryExtractionJobs).where(and(
      eq(schema.personalMemoryExtractionJobs.guildId, guildId), eq(schema.personalMemoryExtractionJobs.subjectId, subjectId),
    )).run();
    return Promise.resolve();
  }
}
