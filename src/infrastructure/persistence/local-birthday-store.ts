import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type { BirthdayRecord, BirthdayStore } from "../../application/birthdays/birthday-store.js";

const guildDocumentSchema = z.object({
  version: z.literal(1),
  users: z.record(z.string(), z.object({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) })),
  announcedDates: z.array(z.string()).default([]),
});
type GuildDocument = z.infer<typeof guildDocumentSchema>;

export class LocalBirthdayStore implements BirthdayStore {
  private readonly birthdaysRoot: string;

  public constructor(runtimeDataDirectory: string) {
    this.birthdaysRoot = resolve(runtimeDataDirectory, "birthdays");
    mkdirSync(this.birthdaysRoot, { recursive: true });
  }

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public setBirthday(guildId: string, userId: string, month: number, day: number): Promise<void> {
    const document = this.read(guildId);
    document.users[userId] = { month, day };
    this.write(guildId, document);
    return Promise.resolve();
  }

  public removeBirthday(guildId: string, userId: string): Promise<boolean> {
    const document = this.read(guildId);
    if (!(userId in document.users)) return Promise.resolve(false);
    delete document.users[userId];
    this.write(guildId, document);
    return Promise.resolve(true);
  }

  public getBirthday(guildId: string, userId: string): Promise<BirthdayRecord | null> {
    const entry = this.read(guildId).users[userId];
    return Promise.resolve(entry ? { userId, ...entry } : null);
  }

  public listForGuildOnDate(guildId: string, month: number, day: number): Promise<readonly string[]> {
    const document = this.read(guildId);
    return Promise.resolve(
      Object.entries(document.users)
        .filter(([, birthday]) => birthday.month === month && birthday.day === day)
        .map(([userId]) => userId),
    );
  }

  public listAllForGuild(guildId: string): Promise<readonly BirthdayRecord[]> {
    const document = this.read(guildId);
    return Promise.resolve(
      Object.entries(document.users).map(([userId, birthday]) => ({ userId, ...birthday })),
    );
  }

  public hasAnnounced(guildId: string, date: string): Promise<boolean> {
    return Promise.resolve(this.read(guildId).announcedDates.includes(date));
  }

  public markAnnounced(guildId: string, date: string): Promise<void> {
    const document = this.read(guildId);
    if (!document.announcedDates.includes(date)) {
      document.announcedDates.push(date);
      if (document.announcedDates.length > 366) document.announcedDates.splice(0, document.announcedDates.length - 366);
      this.write(guildId, document);
    }
    return Promise.resolve();
  }

  private read(guildId: string): GuildDocument {
    const file = this.guildFile(guildId);
    if (!existsSync(file)) return { version: 1, users: {}, announcedDates: [] };
    try {
      return guildDocumentSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new Error(`Unable to read birthdays "${file}".`, { cause: error });
    }
  }

  private write(guildId: string, document: GuildDocument): void {
    const file = this.guildFile(guildId);
    mkdirSync(dirname(file), { recursive: true });
    const temporaryFile = `${file}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temporaryFile, file);
  }

  private guildFile(guildId: string): string {
    return resolve(this.birthdaysRoot, `${safeSegment(guildId)}.json`);
  }
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error(`Unsafe birthday-store identifier "${value}".`);
  return value;
}
