import { parseScopedContextProvenance } from "../../application/chat/context-provenance.js";
import { and, asc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import { chunked } from "../../application/chat/message-revocation-store.js";
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
  public forgetCitingMessages(input: { guildId: string; channelId: string; messageIds: readonly string[] }): Promise<number> {
    const origins = schema.messageOrigins; let changed = 0;
    for (const ids of chunked([...new Set(input.messageIds)])) changed += this.database.transaction((transaction) =>
      transaction.delete(origins).where(and(eq(origins.guildId, input.guildId), eq(origins.channelId, input.channelId), inArray(origins.messageId, ids))).run().changes +
      transaction.update(origins).set({ contextProvenance: null }).where(and(eq(origins.guildId, input.guildId), sql`exists (
        select 1 from json_each(case when json_type(${origins.contextProvenance}, '$.dependencies') = 'array' then json_extract(${origins.contextProvenance}, '$.dependencies') else '[]' end) as dependency
        where json_extract(dependency.value, '$.channelId') = ${input.channelId} and json_extract(dependency.value, '$.messageId') in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        and coalesce(json_extract(dependency.value, '$.projection.kind'), '') <> 'background_text')`)).run().changes);
    return Promise.resolve(changed);
  }
  // Durable chat origins with a stored proof, in (createdAt, messageId) order, after a cursor.
  public pageReplyProofs(after: { createdAt: number; messageId: string } | null, limit: number): Promise<MessageOriginRecord[]> {
    const origins = schema.messageOrigins;
    const rows = this.database.select().from(origins).where(and(eq(origins.origin, "chat"), isNotNull(origins.contextProvenance),
      after ? or(gt(origins.createdAt, new Date(after.createdAt)), and(eq(origins.createdAt, new Date(after.createdAt)), gt(origins.messageId, after.messageId))) : undefined))
      .orderBy(asc(origins.createdAt), asc(origins.messageId)).limit(limit).all();
    return Promise.resolve(rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() })));
  }

  public find(guildId: string, channelId: string, messageId: string): Promise<MessageOriginRecord | null> {
    const row = this.database.select().from(schema.messageOrigins).where(and(
      eq(schema.messageOrigins.guildId, guildId), eq(schema.messageOrigins.channelId, channelId),
      eq(schema.messageOrigins.messageId, messageId),
    )).get();
    return Promise.resolve(row ? { ...row, createdAt: row.createdAt.getTime(), contextProvenance: parseScopedContextProvenance(row.contextProvenance, row) } : null);
  }
}
