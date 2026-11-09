import { parseScopedContextProvenance } from "../../application/chat/context-provenance.js";
import { and, eq, sql } from "drizzle-orm";
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
  public async find(guildId: string, channelId: string, messageId: string): Promise<MessageOriginRecord | null> {
    const [row] = await this.database.select().from(schema.messageOrigins).where(and(
      eq(schema.messageOrigins.guildId, guildId), eq(schema.messageOrigins.channelId, channelId),
      eq(schema.messageOrigins.messageId, messageId),
    )).limit(1);
    return row ? { ...row, createdAt: row.createdAt.getTime(), contextProvenance: parseScopedContextProvenance(row.contextProvenance, row) } : null;
  }
}
