import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  chunked, groupRevocationKeys, revocationKey,
  type MessageCleanupWork, type MessageRevocationInput, type MessageRevocationKey, type MessageRevocationResult, type MessageRevocationStore,
} from "../../application/chat/message-revocation-store.js";
import * as schema from "../database/schema.js";

export class PostgresMessageRevocationStore implements MessageRevocationStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public async revoke(input: MessageRevocationInput): Promise<MessageRevocationResult> {
    const ids = [...new Set(input.messageIds)];
    return this.database.transaction(async (transaction) => {
      // Lock the channel's scope row before anything else, so revocations in one channel commit in
      // revision order and a reader that sees revision N has every revocation up to N.
      const [scope] = await transaction.insert(schema.messageRevocationScopes).values({ guildId: input.guildId, channelId: input.channelId, revision: 0 })
        .onConflictDoUpdate({ target: [schema.messageRevocationScopes.guildId, schema.messageRevocationScopes.channelId], set: { revision: sql`${schema.messageRevocationScopes.revision}` } })
        .returning({ revision: schema.messageRevocationScopes.revision });
      const current = scope!.revision; const revision = current + 1; const revokedAt = new Date(input.revokedAt); const revoked: string[] = [];
      for (const chunk of chunked(ids)) {
        const rows = await transaction.insert(schema.messageRevocations).values(chunk.map((messageId) => ({ guildId: input.guildId, channelId: input.channelId, messageId, revokedAt, revision })))
          .onConflictDoNothing().returning({ messageId: schema.messageRevocations.messageId });
        revoked.push(...rows.map((row) => row.messageId));
      }
      if (!revoked.length) return { revoked: [], revision: current };
      await transaction.update(schema.messageRevocationScopes).set({ revision })
        .where(and(eq(schema.messageRevocationScopes.guildId, input.guildId), eq(schema.messageRevocationScopes.channelId, input.channelId)));
      for (const chunk of chunked(revoked)) {
        await transaction.insert(schema.messageCleanupWork).values(chunk.map((messageId) => ({ guildId: input.guildId, channelId: input.channelId, messageId, state: "pending" as const, attempts: 0, nextAt: revokedAt })))
          .onConflictDoNothing();
      }
      return { revoked, revision };
    });
  }

  public async revoked(keys: readonly MessageRevocationKey[]): Promise<readonly boolean[]> {
    const found = new Set<string>();
    for (const group of groupRevocationKeys(keys).values()) for (const chunk of chunked([...new Set(group.messageIds)])) {
      const rows = await this.database.select({ messageId: schema.messageRevocations.messageId }).from(schema.messageRevocations).where(and(
        eq(schema.messageRevocations.guildId, group.guildId), eq(schema.messageRevocations.channelId, group.channelId), inArray(schema.messageRevocations.messageId, chunk),
      ));
      for (const row of rows) found.add(revocationKey({ ...group, messageId: row.messageId }));
    }
    return keys.map((key) => found.has(revocationKey(key)));
  }

  public async revision(guildId: string, channelId: string): Promise<number> {
    const [row] = await this.database.select({ revision: schema.messageRevocationScopes.revision }).from(schema.messageRevocationScopes)
      .where(and(eq(schema.messageRevocationScopes.guildId, guildId), eq(schema.messageRevocationScopes.channelId, channelId))).limit(1);
    return row?.revision ?? 0;
  }

  public async cleanupWork(keys: readonly MessageRevocationKey[]): Promise<readonly (MessageCleanupWork | null)[]> {
    const found = new Map<string, MessageCleanupWork>();
    for (const group of groupRevocationKeys(keys).values()) for (const chunk of chunked([...new Set(group.messageIds)])) {
      const rows = await this.database.select().from(schema.messageCleanupWork).where(and(
        eq(schema.messageCleanupWork.guildId, group.guildId), eq(schema.messageCleanupWork.channelId, group.channelId), inArray(schema.messageCleanupWork.messageId, chunk),
      ));
      for (const row of rows) found.set(revocationKey(row), { ...row, nextAt: row.nextAt.getTime() });
    }
    return keys.map((key) => found.get(revocationKey(key)) ?? null);
  }
}
