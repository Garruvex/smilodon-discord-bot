import { parseScopedContextProvenance } from "../../application/chat/context-provenance.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chunked } from "../../application/chat/message-revocation-store.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { MessageOriginRecord, MessageOriginStore } from "../../application/chat/message-origin-store.js";
import * as schema from "../database/schema.js";

export class PostgresMessageOriginStore implements MessageOriginStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}
  public async record(input: MessageOriginRecord): Promise<void> {
    await this.database.insert(schema.messageOrigins).values({ ...input, contextProvenance: parseScopedContextProvenance(input.contextProvenance, input), createdAt: new Date(input.createdAt) }).onConflictDoNothing();
  }
  public async invalidateContextSubject(guildId: string, userId: string): Promise<void> {
    await this.database.update(schema.messageOrigins).set({ contextProvenance: null }).where(and(eq(schema.messageOrigins.guildId, guildId), sql`
      (coalesce(${schema.messageOrigins.contextProvenance}->'audience'->>'userId' = ${userId}, false)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${schema.messageOrigins.contextProvenance}->'dependencies', '[]'::jsonb)) AS dependency WHERE dependency->>'authorId' = ${userId})
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${schema.messageOrigins.contextProvenance}->'actors', '[]'::jsonb)) AS actor WHERE actor->>'userId' = ${userId}))
    `));
  }
  public async forgetCitingMessages(input: { guildId: string; channelId: string; messageIds: readonly string[] }): Promise<number> {
    const origins = schema.messageOrigins; let changed = 0;
    for (const ids of chunked([...new Set(input.messageIds)])) changed += await this.database.transaction(async (transaction) => {
      const removed = await transaction.delete(origins).where(and(eq(origins.guildId, input.guildId), eq(origins.channelId, input.channelId), inArray(origins.messageId, ids)))
        .returning({ messageId: origins.messageId });
      const cleared = await transaction.update(origins).set({ contextProvenance: null }).where(and(eq(origins.guildId, input.guildId), sql`exists (
        select 1 from jsonb_array_elements(case when jsonb_typeof(${origins.contextProvenance}->'dependencies') = 'array' then ${origins.contextProvenance}->'dependencies' else '[]'::jsonb end) as dependency
        where dependency->>'channelId' = ${input.channelId} and dependency->>'messageId' in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        and coalesce(dependency->'projection'->>'kind', '') <> 'background_text')`)).returning({ messageId: origins.messageId });
      return removed.length + cleared.length;
    });
    return changed;
  }
  public async find(guildId: string, channelId: string, messageId: string): Promise<MessageOriginRecord | null> {
    const [row] = await this.database.select().from(schema.messageOrigins).where(and(
      eq(schema.messageOrigins.guildId, guildId), eq(schema.messageOrigins.channelId, channelId),
      eq(schema.messageOrigins.messageId, messageId),
    )).limit(1);
    return row ? { ...row, createdAt: row.createdAt.getTime(), contextProvenance: parseScopedContextProvenance(row.contextProvenance, row) } : null;
  }
}
