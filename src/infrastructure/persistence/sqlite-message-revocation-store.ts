import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  chunked, groupRevocationKeys, revocationKey,
  type MessageCleanupClaim, type MessageCleanupWork, type MessageRevocationInput, type MessageRevocationKey, type MessageRevocationResult, type MessageRevocationStore,
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

  public claimCleanup(input: { now: number; limit: number; leaseMs: number }): Promise<readonly MessageCleanupClaim[]> {
    const work = schema.messageCleanupWork; const leaseUntil = input.now + input.leaseMs;
    // SQLite runs one write transaction at a time, so selecting and then claiming cannot hand a row out twice.
    return Promise.resolve(this.database.transaction((transaction) => {
      const due = transaction.select().from(work).where(and(lte(work.nextAt, new Date(input.now)),
        or(eq(work.state, "pending"), eq(work.state, "settling"), eq(work.state, "claimed"))))
        .orderBy(asc(work.nextAt), asc(work.guildId), asc(work.channelId), asc(work.messageId)).limit(input.limit).all();
      for (const row of due) transaction.update(work).set({ state: "claimed", nextAt: new Date(leaseUntil) }).where(this.key(row)).run();
      return due.map((row): MessageCleanupClaim => ({ guildId: row.guildId, channelId: row.channelId, messageId: row.messageId,
        pass: row.state === "settling" ? "settle" : "first", attempts: row.attempts, leaseUntil }));
    }));
  }

  public completeCleanup(claim: MessageCleanupClaim, input: { now: number; settleMs: number }): Promise<boolean> {
    const settling = claim.pass === "first";
    return Promise.resolve(this.database.update(schema.messageCleanupWork)
      .set({ state: settling ? "settling" : "done", attempts: 0, nextAt: new Date(settling ? input.now + input.settleMs : input.now) })
      .where(this.held(claim)).run().changes > 0);
  }

  public retryCleanup(claim: MessageCleanupClaim, input: { retryAt: number }): Promise<boolean> {
    return Promise.resolve(this.database.update(schema.messageCleanupWork)
      .set({ state: claim.pass === "first" ? "pending" : "settling", attempts: claim.attempts + 1, nextAt: new Date(input.retryAt) })
      .where(this.held(claim)).run().changes > 0);
  }

  private key(key: MessageRevocationKey): ReturnType<typeof and> {
    const work = schema.messageCleanupWork;
    return and(eq(work.guildId, key.guildId), eq(work.channelId, key.channelId), eq(work.messageId, key.messageId));
  }
  // The row is still claimed by this holder: leaseUntil is the claim token.
  private held(claim: MessageCleanupClaim): ReturnType<typeof and> {
    const work = schema.messageCleanupWork;
    return and(this.key(claim), eq(work.state, "claimed"), eq(work.nextAt, new Date(claim.leaseUntil)));
  }
}
