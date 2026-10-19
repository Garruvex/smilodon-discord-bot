import { parseScopedContextProvenance } from "../../application/chat/context-provenance.js";
import { and, eq, sql } from "drizzle-orm";
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
  public invalidateContextSubject(guildId: string, userId: string): Promise<void> {
    this.database.update(schema.messageOrigins).set({ contextProvenance: null }).where(and(eq(schema.messageOrigins.guildId, guildId), sql`
      (coalesce(json_extract(${schema.messageOrigins.contextProvenance}, '$.audience.userId') = ${userId}, 0)
      OR EXISTS (SELECT 1 FROM json_each(${schema.messageOrigins.contextProvenance}, '$.dependencies') AS dependency WHERE json_extract(dependency.value, '$.authorId') = ${userId})
      OR EXISTS (SELECT 1 FROM json_each(${schema.messageOrigins.contextProvenance}, '$.actors') AS actor WHERE json_extract(actor.value, '$.userId') = ${userId}))
    `)).run();
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
