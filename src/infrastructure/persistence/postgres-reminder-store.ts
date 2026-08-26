import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { ReminderDelivery, ReminderRecord, ReminderStore } from "../../application/reminders/reminder-store.js";
import * as schema from "../database/schema.js";

function toRecord(row: typeof schema.reminders.$inferSelect): ReminderRecord {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    channelId: row.channelId,
    message: row.message,
    delivery: row.delivery as ReminderDelivery,
    dueAt: row.dueAt.getTime(),
    createdAt: row.createdAt.getTime(),
  };
}

export class PostgresReminderStore implements ReminderStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public async create(record: Omit<ReminderRecord, "id" | "createdAt">): Promise<ReminderRecord> {
    const rows = await this.database.insert(schema.reminders).values({
      id: randomUUID(),
      guildId: record.guildId,
      userId: record.userId,
      channelId: record.channelId,
      message: record.message,
      delivery: record.delivery,
      dueAt: new Date(record.dueAt),
    }).returning();
    return toRecord(rows[0]!);
  }

  public async listForUser(guildId: string, userId: string): Promise<readonly ReminderRecord[]> {
    const rows = await this.database.select().from(schema.reminders).where(and(
      eq(schema.reminders.guildId, guildId),
      eq(schema.reminders.userId, userId),
      isNull(schema.reminders.firedAt),
    )).orderBy(asc(schema.reminders.dueAt));
    return rows.map(toRecord);
  }

  public async cancel(id: string, userId: string): Promise<boolean> {
    const result = await this.database.delete(schema.reminders).where(and(
      eq(schema.reminders.id, id),
      eq(schema.reminders.userId, userId),
    )).returning({ id: schema.reminders.id });
    return result.length > 0;
  }

  public async listDue(now: number): Promise<readonly ReminderRecord[]> {
    const rows = await this.database.select().from(schema.reminders).where(and(
      lte(schema.reminders.dueAt, new Date(now)),
      isNull(schema.reminders.firedAt),
    ));
    return rows.map(toRecord);
  }

  public async markFired(id: string): Promise<void> {
    await this.database.update(schema.reminders)
      .set({ firedAt: new Date() })
      .where(eq(schema.reminders.id, id));
  }
}
