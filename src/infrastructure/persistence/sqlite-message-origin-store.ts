import { parseScopedContextProvenance } from "../../application/chat/context-provenance.js";
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { MessageOriginRecord, MessageOriginStore } from "../../application/chat/message-origin-store.js";
import * as schema from "../database/sqlite-schema.js";

export class SqliteMessageOriginStore implements MessageOriginStore {
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}
  public record(input: MessageOriginRecord): Promise<void> {
    this.database.insert(schema.messageOrigins).values({ ...input, contextProvenance: parseScopedContextProvenance(input.contextProvenance, input), createdAt: new Date(input.createdAt) })
      .onConflictDoNothing().run();
    return Promise.resolve();
  }
  public find(guildId: string, channelId: string, messageId: string): Promise<MessageOriginRecord | null> {
    const row = this.database.select().from(schema.messageOrigins).where(and(
      eq(schema.messageOrigins.guildId, guildId), eq(schema.messageOrigins.channelId, channelId),
      eq(schema.messageOrigins.messageId, messageId),
    )).get();
    return Promise.resolve(row ? { ...row, createdAt: row.createdAt.getTime(), contextProvenance: parseScopedContextProvenance(row.contextProvenance, row) } : null);
  }
}
