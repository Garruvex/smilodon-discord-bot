import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { BirthdayRecord, BirthdayStore } from "../../application/birthdays/birthday-store.js";
import * as schema from "../database/schema.js";

export class PostgresBirthdayStore implements BirthdayStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public async setBirthday(guildId: string, userId: string, month: number, day: number): Promise<void> {
    await this.database.insert(schema.birthdays).values({
      guildId, userId, month, day, updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.birthdays.guildId, schema.birthdays.userId],
      set: { month, day, updatedAt: new Date() },
    });
  }

  public async removeBirthday(guildId: string, userId: string): Promise<boolean> {
    const result = await this.database.delete(schema.birthdays).where(and(
      eq(schema.birthdays.guildId, guildId),
      eq(schema.birthdays.userId, userId),
    )).returning({ userId: schema.birthdays.userId });
    return result.length > 0;
  }

  public async getBirthday(guildId: string, userId: string): Promise<BirthdayRecord | null> {
    const rows = await this.database.select().from(schema.birthdays).where(and(
      eq(schema.birthdays.guildId, guildId),
      eq(schema.birthdays.userId, userId),
    )).limit(1);
    const row = rows[0];
    return row ? { userId: row.userId, month: row.month, day: row.day } : null;
  }

  public async listForGuildOnDate(guildId: string, month: number, day: number): Promise<readonly string[]> {
    const rows = await this.database.select({ userId: schema.birthdays.userId }).from(schema.birthdays).where(and(
      eq(schema.birthdays.guildId, guildId),
      eq(schema.birthdays.month, month),
      eq(schema.birthdays.day, day),
    ));
    return rows.map((row) => row.userId);
  }

  public async hasAnnounced(guildId: string, date: string): Promise<boolean> {
    const rows = await this.database.select({ date: schema.birthdayAnnouncements.date })
      .from(schema.birthdayAnnouncements)
      .where(and(eq(schema.birthdayAnnouncements.guildId, guildId), eq(schema.birthdayAnnouncements.date, date)))
      .limit(1);
    return rows.length > 0;
  }

  public async markAnnounced(guildId: string, date: string): Promise<void> {
    await this.database.insert(schema.birthdayAnnouncements).values({
      guildId, date, announcedAt: new Date(),
    }).onConflictDoNothing();
  }
}
