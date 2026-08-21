import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type { ChannelSummaryCheckpoint, ChannelSummaryCheckpointStore } from "../../application/context/channel-summary-checkpoint-store.js";
import * as schema from "../database/sqlite-schema.js";

export class SqliteChannelSummaryCheckpointStore implements ChannelSummaryCheckpointStore {
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}
  public initialize(): Promise<void> { return Promise.resolve(); }

  public get(guildId: string, channelId: string): Promise<ChannelSummaryCheckpoint | null> {
    const row = this.database.select().from(schema.channelSummaryCheckpoints).where(and(
      eq(schema.channelSummaryCheckpoints.guildId, guildId), eq(schema.channelSummaryCheckpoints.channelId, channelId),
    )).get();
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      guildId: row.guildId, channelId: row.channelId, lastMessageId: row.lastMessageId,
      scanCompletedAt: row.scanCompletedAt ? row.scanCompletedAt.getTime() : null,
      dailyCursor: row.dailyCursor,
      dailyHighWaterMarkAt: row.dailyHighWaterMarkAt ? row.dailyHighWaterMarkAt.getTime() : null,
      lastRunAt: row.lastRunAt ? row.lastRunAt.getTime() : null,
      lastError: row.lastError,
      lastErrorCode: row.lastErrorCode,
      lastSuccessAt: row.lastSuccessAt ? row.lastSuccessAt.getTime() : null,
    });
  }

  public recordSuccess(input: {
    guildId: string; channelId: string; now: number;
    lastMessageId?: string; scanComplete?: boolean;
    dailyCursor?: string; dailyComplete?: boolean; dailyHighWaterMarkAt?: number;
  }): Promise<void> {
    const existing = this.database.select().from(schema.channelSummaryCheckpoints).where(and(
      eq(schema.channelSummaryCheckpoints.guildId, input.guildId), eq(schema.channelSummaryCheckpoints.channelId, input.channelId),
    )).get();
    const nowDate = new Date(input.now);
    const dailyHighWaterMarkAt = input.dailyComplete
      ? nowDate
      : input.dailyHighWaterMarkAt !== undefined ? new Date(input.dailyHighWaterMarkAt) : (existing?.dailyHighWaterMarkAt ?? null);
    const values = {
      lastMessageId: input.lastMessageId ?? existing?.lastMessageId ?? null,
      scanCompletedAt: input.scanComplete ? nowDate : (existing?.scanCompletedAt ?? null),
      dailyCursor: input.dailyComplete ? null : (input.dailyCursor ?? existing?.dailyCursor ?? null),
      dailyHighWaterMarkAt,
      lastRunAt: input.dailyComplete ? nowDate : (existing?.lastRunAt ?? null),
      lastError: null,
      lastErrorCode: null,
      lastSuccessAt: nowDate,
      updatedAt: nowDate,
    };
    if (existing) {
      this.database.update(schema.channelSummaryCheckpoints).set(values).where(and(
        eq(schema.channelSummaryCheckpoints.guildId, input.guildId), eq(schema.channelSummaryCheckpoints.channelId, input.channelId),
      )).run();
    } else {
      this.database.insert(schema.channelSummaryCheckpoints).values({
        guildId: input.guildId, channelId: input.channelId, ...values, createdAt: nowDate,
      }).run();
    }
    return Promise.resolve();
  }

  public recordError(guildId: string, channelId: string, code: string, error: string, now: number): Promise<void> {
    const existing = this.database.select().from(schema.channelSummaryCheckpoints).where(and(
      eq(schema.channelSummaryCheckpoints.guildId, guildId), eq(schema.channelSummaryCheckpoints.channelId, channelId),
    )).get();
    const nowDate = new Date(now);
    if (existing) {
      this.database.update(schema.channelSummaryCheckpoints).set({ lastError: error, lastErrorCode: code, updatedAt: nowDate })
        .where(and(eq(schema.channelSummaryCheckpoints.guildId, guildId), eq(schema.channelSummaryCheckpoints.channelId, channelId))).run();
    } else {
      this.database.insert(schema.channelSummaryCheckpoints).values({
        guildId, channelId, lastMessageId: null, scanCompletedAt: null,
        dailyCursor: null, dailyHighWaterMarkAt: null, lastRunAt: null,
        lastError: error, lastErrorCode: code, lastSuccessAt: null, createdAt: nowDate, updatedAt: nowDate,
      }).run();
    }
    return Promise.resolve();
  }

  public resetScan(guildId: string, channelId: string, now: number): Promise<void> {
    const existing = this.database.select().from(schema.channelSummaryCheckpoints).where(and(
      eq(schema.channelSummaryCheckpoints.guildId, guildId), eq(schema.channelSummaryCheckpoints.channelId, channelId),
    )).get();
    const nowDate = new Date(now);
    if (existing) {
      this.database.update(schema.channelSummaryCheckpoints).set({
        lastMessageId: null, scanCompletedAt: null, lastError: null, lastErrorCode: null, updatedAt: nowDate,
      }).where(and(
        eq(schema.channelSummaryCheckpoints.guildId, guildId), eq(schema.channelSummaryCheckpoints.channelId, channelId),
      )).run();
    } else {
      this.database.insert(schema.channelSummaryCheckpoints).values({
        guildId, channelId, lastMessageId: null, scanCompletedAt: null,
        dailyCursor: null, dailyHighWaterMarkAt: null, lastRunAt: null,
        lastError: null, lastErrorCode: null, lastSuccessAt: null, createdAt: nowDate, updatedAt: nowDate,
      }).run();
    }
    return Promise.resolve();
  }
}
