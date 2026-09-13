import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type { BoostEvent, BoostEventType, BoostHistoryStore } from "../../application/members/boost-history-store.js";

const eventSchema = z.object({
  eventType: z.enum(["started", "ended"]),
  occurredAt: z.coerce.date(),
});
const guildDocumentSchema = z.object({
  version: z.literal(1),
  users: z.record(z.string(), z.array(eventSchema)),
});
type GuildDocument = z.infer<typeof guildDocumentSchema>;

export class LocalBoostHistoryStore implements BoostHistoryStore {
  private readonly boostHistoryRoot: string;

  public constructor(runtimeDataDirectory: string) {
    this.boostHistoryRoot = resolve(runtimeDataDirectory, "boost-history");
    mkdirSync(this.boostHistoryRoot, { recursive: true });
  }

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public recordEvent(guildId: string, userId: string, eventType: BoostEventType, occurredAt: Date): Promise<void> {
    const document = this.read(guildId);
    const events = document.users[userId] ?? [];
    events.push({ eventType, occurredAt });
    document.users[userId] = events;
    this.write(guildId, document);
    return Promise.resolve();
  }

  public listEvents(guildId: string, userId: string): Promise<readonly BoostEvent[]> {
    const events = this.read(guildId).users[userId] ?? [];
    return Promise.resolve([...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()));
  }

  public removeForUser(guildId: string, userId: string): Promise<void> {
    const document = this.read(guildId);
    if (userId in document.users) {
      delete document.users[userId];
      this.write(guildId, document);
    }
    return Promise.resolve();
  }

  private read(guildId: string): GuildDocument {
    const file = this.guildFile(guildId);
    if (!existsSync(file)) return { version: 1, users: {} };
    try {
      return guildDocumentSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new Error(`Unable to read boost history "${file}".`, { cause: error });
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
    return resolve(this.boostHistoryRoot, `${safeSegment(guildId)}.json`);
  }
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error(`Unsafe boost-history-store identifier "${value}".`);
  return value;
}
