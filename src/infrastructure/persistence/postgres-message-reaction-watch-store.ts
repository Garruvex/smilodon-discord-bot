import { and, asc, eq, lt, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type {
  MessageReactionWatch,
  MessageReactionWatchStore,
} from "../../application/chat/message-reaction-watch.js";
import * as schema from "../database/schema.js";

function toWatch(row: typeof schema.messageReactionWatches.$inferSelect): MessageReactionWatch {
  return {
    messageId: row.messageId,
    guildId: row.guildId,
    channelId: row.channelId,
    status: row.status as MessageReactionWatch["status"],
    firstReactionAt: row.firstReactionAt ? row.firstReactionAt.getTime() : null,
    dueAt: row.dueAt ? row.dueAt.getTime() : null,
  };
}

export class PostgresMessageReactionWatchStore implements MessageReactionWatchStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}
  public initialize(): Promise<void> { return Promise.resolve(); }

  public async register(input: { guildId: string; channelId: string; messageId: string }, now: number): Promise<void> {
    const nowDate = new Date(now);
    await this.database.insert(schema.messageReactionWatches).values({
      messageId: input.messageId, guildId: input.guildId, channelId: input.channelId,
      status: "watching", firstReactionAt: null, dueAt: null, createdAt: nowDate, updatedAt: nowDate,
    }).onConflictDoNothing();
  }

  public async armOnFirstReaction(messageId: string, now: number, windowMs: number): Promise<boolean> {
    const updated = await this.database.update(schema.messageReactionWatches).set({
      status: "pending", firstReactionAt: new Date(now), dueAt: new Date(now + windowMs), updatedAt: new Date(now),
    }).where(and(
      eq(schema.messageReactionWatches.messageId, messageId),
      eq(schema.messageReactionWatches.status, "watching"),
    )).returning({ messageId: schema.messageReactionWatches.messageId });
    return updated.length > 0;
  }

  public async dequeueDue(limit: number, now: number): Promise<readonly MessageReactionWatch[]> {
    const rows = await this.database.select().from(schema.messageReactionWatches).where(and(
      eq(schema.messageReactionWatches.status, "pending"),
      lte(schema.messageReactionWatches.dueAt, new Date(now)),
    )).orderBy(asc(schema.messageReactionWatches.dueAt)).limit(limit);
    return rows.map(toWatch);
  }

  public async markDone(messageId: string, now: number): Promise<void> {
    await this.database.update(schema.messageReactionWatches).set({
      status: "done", updatedAt: new Date(now),
    }).where(eq(schema.messageReactionWatches.messageId, messageId));
  }

  public async deleteOlderThan(cutoff: number): Promise<number> {
    const deleted = await this.database.delete(schema.messageReactionWatches)
      .where(lt(schema.messageReactionWatches.updatedAt, new Date(cutoff)))
      .returning({ messageId: schema.messageReactionWatches.messageId });
    return deleted.length;
  }
}
