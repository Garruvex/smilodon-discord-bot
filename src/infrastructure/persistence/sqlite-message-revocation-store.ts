import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  chunked, groupRevocationKeys, revocationKey,
  type MessageCleanupWork, type MessageRevocationInput, type MessageRevocationKey, type MessageRevocationResult, type MessageRevocationStore,
} from "../../application/chat/message-revocation-store.js";
import * as schema from "../database/sqlite-schema.js";

export class SqliteMessageRevocationStore implements MessageRevocationStore {
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}

  public revoke(input: MessageRevocationInput): Promise<MessageRevocationResult> {
    const ids = [...new Set(input.messageIds)];
    const scope = and(eq(schema.messageRevocationScopes.guildId, input.guildId), eq(schema.messageRevocationScopes.channelId, input.channelId));
    // SQLite runs one write transaction at a time, so reading the revision inside it is already serialized.
    return Promise.resolve(this.database.transaction((transaction) => {
      const current = transaction.select({ revision: schema.messageRevocationScopes.revision }).from(schema.messageRevocationScopes).where(scope).get()?.revision ?? 0;
      const revision = current + 1; const revokedAt = new Date(input.revokedAt); const revoked: string[] = [];
      for (const chunk of chunked(ids)) {
        const rows = transaction.insert(schema.messageRevocations).values(chunk.map((messageId) => ({ guildId: input.guildId, channelId: input.channelId, messageId, revokedAt, revision })))
          .onConflictDoNothing().returning({ messageId: schema.messageRevocations.messageId }).all();
        revoked.push(...rows.map((row) => row.messageId));
      }
      if (!revoked.length) return { revoked: [], revision: current };
      transaction.insert(schema.messageRevocationScopes).values({ guildId: input.guildId, channelId: input.channelId, revision })
        .onConflictDoUpdate({ target: [schema.messageRevocationScopes.guildId, schema.messageRevocationScopes.channelId], set: { revision } }).run();
      for (const chunk of chunked(revoked)) {
        transaction.insert(schema.messageCleanupWork).values(chunk.map((messageId) => ({ guildId: input.guildId, channelId: input.channelId, messageId, state: "pending" as const, attempts: 0, nextAt: revokedAt })))
          .onConflictDoNothing().run();
      }
      return { revoked, revision };
    }));
  }

  public revoked(keys: readonly MessageRevocationKey[]): Promise<readonly boolean[]> {
    const found = new Set<string>();
    for (const group of groupRevocationKeys(keys).values()) for (const chunk of chunked([...new Set(group.messageIds)])) {
      const rows = this.database.select({ messageId: schema.messageRevocations.messageId }).from(schema.messageRevocations).where(and(
        eq(schema.messageRevocations.guildId, group.guildId), eq(schema.messageRevocations.channelId, group.channelId), inArray(schema.messageRevocations.messageId, chunk),
      )).all();
      for (const row of rows) found.add(revocationKey({ ...group, messageId: row.messageId }));
    }
    return Promise.resolve(keys.map((key) => found.has(revocationKey(key))));
  }

  public revision(guildId: string, channelId: string): Promise<number> {
    const row = this.database.select({ revision: schema.messageRevocationScopes.revision }).from(schema.messageRevocationScopes)
      .where(and(eq(schema.messageRevocationScopes.guildId, guildId), eq(schema.messageRevocationScopes.channelId, channelId))).get();
    return Promise.resolve(row?.revision ?? 0);
  }

  public cleanupWork(keys: readonly MessageRevocationKey[]): Promise<readonly (MessageCleanupWork | null)[]> {
    const found = new Map<string, MessageCleanupWork>();
    for (const group of groupRevocationKeys(keys).values()) for (const chunk of chunked([...new Set(group.messageIds)])) {
      const rows = this.database.select().from(schema.messageCleanupWork).where(and(
        eq(schema.messageCleanupWork.guildId, group.guildId), eq(schema.messageCleanupWork.channelId, group.channelId), inArray(schema.messageCleanupWork.messageId, chunk),
      )).all();
      for (const row of rows) found.set(revocationKey(row), { ...row, nextAt: row.nextAt.getTime() });
    }
    return Promise.resolve(keys.map((key) => found.get(revocationKey(key)) ?? null));
  }
}
