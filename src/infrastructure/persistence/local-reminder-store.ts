import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type { ReminderRecord, ReminderStore } from "../../application/reminders/reminder-store.js";

const reminderSchema = z.object({
  id: z.string(),
  guildId: z.string(),
  userId: z.string(),
  channelId: z.string(),
  message: z.string(),
  delivery: z.enum(["dm", "channel"]).default("dm"),
  dueAt: z.number(),
  createdAt: z.number(),
  firedAt: z.number().nullable(),
});
type StoredReminder = z.infer<typeof reminderSchema>;

const documentSchema = z.object({
  version: z.literal(1),
  reminders: z.array(reminderSchema),
});
type Document = z.infer<typeof documentSchema>;

function toRecord(stored: StoredReminder): ReminderRecord {
  return {
    id: stored.id,
    guildId: stored.guildId,
    userId: stored.userId,
    channelId: stored.channelId,
    message: stored.message,
    delivery: stored.delivery,
    dueAt: stored.dueAt,
    createdAt: stored.createdAt,
  };
}

// Unlike birthdays (sharded per-guild JSON, fine since it only ever queries
// "today, this guild"), reminders need a global "what's due right now across
// every guild" scan every tick — a single flat file keeps that a plain array
// filter instead of reading every guild's shard each tick.
export class LocalReminderStore implements ReminderStore {
  private readonly file: string;

  public constructor(runtimeDataDirectory: string) {
    this.file = resolve(runtimeDataDirectory, "reminders", "reminders.json");
    mkdirSync(dirname(this.file), { recursive: true });
  }

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public create(record: Omit<ReminderRecord, "id" | "createdAt">): Promise<ReminderRecord> {
    const document = this.read();
    const stored: StoredReminder = {
      id: randomUUID(),
      guildId: record.guildId,
      userId: record.userId,
      channelId: record.channelId,
      message: record.message,
      delivery: record.delivery,
      dueAt: record.dueAt,
      createdAt: Date.now(),
      firedAt: null,
    };
    document.reminders.push(stored);
    this.write(document);
    return Promise.resolve(toRecord(stored));
  }

  public listForUser(guildId: string, userId: string): Promise<readonly ReminderRecord[]> {
    const document = this.read();
    return Promise.resolve(
      document.reminders
        .filter((r) => r.guildId === guildId && r.userId === userId && r.firedAt === null)
        .sort((a, b) => a.dueAt - b.dueAt)
        .map(toRecord),
    );
  }

  public cancel(id: string, userId: string): Promise<boolean> {
    const document = this.read();
    const index = document.reminders.findIndex((r) => r.id === id && r.userId === userId);
    if (index === -1) return Promise.resolve(false);
    document.reminders.splice(index, 1);
    this.write(document);
    return Promise.resolve(true);
  }

  public listDue(now: number): Promise<readonly ReminderRecord[]> {
    const document = this.read();
    return Promise.resolve(
      document.reminders
        .filter((r) => r.firedAt === null && r.dueAt <= now)
        .map(toRecord),
    );
  }

  public markFired(id: string): Promise<void> {
    const document = this.read();
    const reminder = document.reminders.find((r) => r.id === id);
    if (reminder && reminder.firedAt === null) {
      reminder.firedAt = Date.now();
      this.write(document);
    }
    return Promise.resolve();
  }

  private read(): Document {
    if (!existsSync(this.file)) return { version: 1, reminders: [] };
    try {
      return documentSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (error) {
      throw new Error(`Unable to read reminders "${this.file}".`, { cause: error });
    }
  }

  private write(document: Document): void {
    // Bound the file's growth — a fired reminder has no further use after a
    // week (listForUser/listDue both already exclude it), so it's dropped
    // rather than kept forever.
    const pruneBeforeMs = Date.now() - 7 * 24 * 60 * 60 * 1_000;
    document.reminders = document.reminders.filter((r) => r.firedAt === null || r.firedAt >= pruneBeforeMs);
    mkdirSync(dirname(this.file), { recursive: true });
    const temporaryFile = `${this.file}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temporaryFile, this.file);
  }
}
