import { and, asc, eq, lt, lte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type {
  MessageReactionWatch,
  MessageReactionWatchStore,
} from "../../application/chat/message-reaction-watch.js";
import * as schema from "../database/sqlite-schema.js";

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

export class SqliteMessageReactionWatchStore implements MessageReactionWatchStore {
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}
  public initialize(): Promise<void> { return Promise.resolve(); }

  public register(input: { guildId: string; channelId: string; messageId: string }, now: number): Promise<void> {
    const nowDate = new Date(now);
    this.database.insert(schema.messageReactionWatches).values({
      messageId: input.messageId, guildId: input.guildId, channelId: input.channelId,
      status: "watching", firstReactionAt: null, dueAt: null, createdAt: nowDate, updatedAt: nowDate,
    }).onConflictDoNothing().run();
    return Promise.resolve();
  }

  public armOnFirstReaction(messageId: string, now: number, windowMs: number): Promise<boolean> {
    const result = this.database.update(schema.messageReactionWatches).set({
      status: "pending", firstReactionAt: new Date(now), dueAt: new Date(now + windowMs), updatedAt: new Date(now),
    }).where(and(
      eq(schema.messageReactionWatches.messageId, messageId),
      eq(schema.messageReactionWatches.status, "watching"),
    )).run();
    return Promise.resolve(result.changes > 0);
  }

  public dequeueDue(limit: number, now: number): Promise<readonly MessageReactionWatch[]> {
    const rows = this.database.select().from(schema.messageReactionWatches).where(and(
      eq(schema.messageReactionWatches.status, "pending"),
      lte(schema.messageReactionWatches.dueAt, new Date(now)),
    )).orderBy(asc(schema.messageReactionWatches.dueAt)).limit(limit).all();
    return Promise.resolve(rows.map(toWatch));
  }

  public markDone(messageId: string, now: number): Promise<void> {
    this.database.update(schema.messageReactionWatches).set({
      status: "done", updatedAt: new Date(now),
    }).where(eq(schema.messageReactionWatches.messageId, messageId)).run();
    return Promise.resolve();
  }

  public deleteOlderThan(cutoff: number): Promise<number> {
    const result = this.database.delete(schema.messageReactionWatches)
      .where(lt(schema.messageReactionWatches.updatedAt, new Date(cutoff)))
      .run();
    return Promise.resolve(result.changes);
  }
}
