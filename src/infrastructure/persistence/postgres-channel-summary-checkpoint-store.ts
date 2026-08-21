import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { ChannelSummaryCheckpoint, ChannelSummaryCheckpointStore } from "../../application/context/channel-summary-checkpoint-store.js";
import * as schema from "../database/schema.js";

export class PostgresChannelSummaryCheckpointStore implements ChannelSummaryCheckpointStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}
  public initialize(): Promise<void> { return Promise.resolve(); }

  public async get(guildId: string, channelId: string): Promise<ChannelSummaryCheckpoint | null> {
    const rows = await this.database.select().from(schema.channelSummaryCheckpoints).where(and(
      eq(schema.channelSummaryCheckpoints.guildId, guildId), eq(schema.channelSummaryCheckpoints.channelId, channelId),
    )).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      guildId: row.guildId, channelId: row.channelId, lastMessageId: row.lastMessageId,
      scanCompletedAt: row.scanCompletedAt ? row.scanCompletedAt.getTime() : null,
      dailyCursor: row.dailyCursor,
      dailyHighWaterMarkAt: row.dailyHighWaterMarkAt ? row.dailyHighWaterMarkAt.getTime() : null,
      lastRunAt: row.lastRunAt ? row.lastRunAt.getTime() : null,
      lastError: row.lastError,
      lastErrorCode: row.lastErrorCode,
      lastSuccessAt: row.lastSuccessAt ? row.lastSuccessAt.getTime() : null,
    };
  }

  public async recordSuccess(input: {
    guildId: string; channelId: string; now: number;
    lastMessageId?: string; scanComplete?: boolean;
    dailyCursor?: string; dailyComplete?: boolean; dailyHighWaterMarkAt?: number;
  }): Promise<void> {
    const nowDate = new Date(input.now);
    const dailyHighWaterMarkAt = input.dailyComplete
      ? nowDate
      : input.dailyHighWaterMarkAt !== undefined ? new Date(input.dailyHighWaterMarkAt) : null;
    await this.database.insert(schema.channelSummaryCheckpoints).values({
      guildId: input.guildId, channelId: input.channelId,
      lastMessageId: input.lastMessageId ?? null,
      scanCompletedAt: input.scanComplete ? nowDate : null,
      dailyCursor: input.dailyComplete ? null : (input.dailyCursor ?? null),
      dailyHighWaterMarkAt,
      lastRunAt: input.dailyComplete ? nowDate : null,
      lastError: null, lastErrorCode: null, lastSuccessAt: nowDate,
      createdAt: nowDate, updatedAt: nowDate,
    }).onConflictDoUpdate({
      target: [schema.channelSummaryCheckpoints.guildId, schema.channelSummaryCheckpoints.channelId],
      set: {
        ...(input.lastMessageId !== undefined ? { lastMessageId: input.lastMessageId } : {}),
        ...(input.scanComplete ? { scanCompletedAt: nowDate } : {}),
        ...(input.dailyComplete
          ? { dailyCursor: null, dailyHighWaterMarkAt: nowDate, lastRunAt: nowDate }
          : input.dailyCursor !== undefined ? { dailyCursor: input.dailyCursor } : {}),
        ...(!input.dailyComplete && input.dailyHighWaterMarkAt !== undefined
          ? { dailyHighWaterMarkAt: new Date(input.dailyHighWaterMarkAt) }
          : {}),
        lastError: null, lastErrorCode: null, lastSuccessAt: nowDate,
        updatedAt: nowDate,
      },
    });
  }

  public async recordError(guildId: string, channelId: string, code: string, error: string, now: number): Promise<void> {
    const nowDate = new Date(now);
    await this.database.insert(schema.channelSummaryCheckpoints).values({
      guildId, channelId, lastMessageId: null, scanCompletedAt: null,
      dailyCursor: null, dailyHighWaterMarkAt: null, lastRunAt: null,
      lastError: error, lastErrorCode: code, lastSuccessAt: null, createdAt: nowDate, updatedAt: nowDate,
    }).onConflictDoUpdate({
      target: [schema.channelSummaryCheckpoints.guildId, schema.channelSummaryCheckpoints.channelId],
      set: { lastError: error, lastErrorCode: code, updatedAt: nowDate },
    });
  }

  public async resetScan(guildId: string, channelId: string, now: number): Promise<void> {
    const nowDate = new Date(now);
    await this.database.insert(schema.channelSummaryCheckpoints).values({
      guildId, channelId, lastMessageId: null, scanCompletedAt: null,
      dailyCursor: null, dailyHighWaterMarkAt: null, lastRunAt: null,
      lastError: null, lastErrorCode: null, lastSuccessAt: null, createdAt: nowDate, updatedAt: nowDate,
    }).onConflictDoUpdate({
      target: [schema.channelSummaryCheckpoints.guildId, schema.channelSummaryCheckpoints.channelId],
      set: { lastMessageId: null, scanCompletedAt: null, lastError: null, lastErrorCode: null, updatedAt: nowDate },
    });
  }
}
