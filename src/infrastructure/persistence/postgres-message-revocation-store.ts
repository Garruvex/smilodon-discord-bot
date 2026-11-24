import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  chunked, groupRevocationKeys, revocationKey,
  type MessageCleanupClaim, type MessageCleanupWork, type MessageRevocationInput, type MessageRevocationKey, type MessageRevocationResult, type MessageRevocationStore,
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

  public async claimCleanup(input: { now: number; limit: number; leaseMs: number }): Promise<readonly MessageCleanupClaim[]> {
    const work = schema.messageCleanupWork; const leaseUntil = input.now + input.leaseMs;
    // SKIP LOCKED lets concurrent claimers each take different due rows instead of waiting or overlapping.
    const rows = await this.database.execute<{ guildId: string; channelId: string; messageId: string; previous: string; attempts: number }>(sql`
      WITH due AS (
        SELECT guild_id, channel_id, message_id, state FROM ${work}
        WHERE state IN ('pending', 'settling', 'claimed') AND next_at <= ${sql.param(new Date(input.now), work.nextAt)}
        ORDER BY next_at, guild_id, channel_id, message_id LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED)
      UPDATE ${work} AS claimed SET state = 'claimed', next_at = ${sql.param(new Date(leaseUntil), work.nextAt)} FROM due
      WHERE claimed.guild_id = due.guild_id AND claimed.channel_id = due.channel_id AND claimed.message_id = due.message_id
      RETURNING claimed.guild_id AS "guildId", claimed.channel_id AS "channelId", claimed.message_id AS "messageId", due.state AS previous, claimed.attempts AS attempts`);
    return [...rows].map((row): MessageCleanupClaim => ({ guildId: row.guildId, channelId: row.channelId, messageId: row.messageId,
      pass: row.previous === "settling" ? "settle" : "first", attempts: Number(row.attempts), leaseUntil }));
  }

  public async completeCleanup(claim: MessageCleanupClaim, input: { now: number; settleMs: number }): Promise<boolean> {
    const settling = claim.pass === "first";
    const rows = await this.database.update(schema.messageCleanupWork)
      .set({ state: settling ? "settling" : "done", attempts: 0, nextAt: new Date(settling ? input.now + input.settleMs : input.now) })
      .where(this.held(claim)).returning({ messageId: schema.messageCleanupWork.messageId });
    return rows.length > 0;
  }

  public async retryCleanup(claim: MessageCleanupClaim, input: { retryAt: number }): Promise<boolean> {
    const rows = await this.database.update(schema.messageCleanupWork)
      .set({ state: claim.pass === "first" ? "pending" : "settling", attempts: claim.attempts + 1, nextAt: new Date(input.retryAt) })
      .where(this.held(claim)).returning({ messageId: schema.messageCleanupWork.messageId });
    return rows.length > 0;
  }

  // The row is still claimed by this holder: leaseUntil is the claim token.
  private held(claim: MessageCleanupClaim): ReturnType<typeof and> {
    const work = schema.messageCleanupWork;
    return and(eq(work.guildId, claim.guildId), eq(work.channelId, claim.channelId), eq(work.messageId, claim.messageId),
      eq(work.state, "claimed"), eq(work.nextAt, new Date(claim.leaseUntil)));
  }
}
