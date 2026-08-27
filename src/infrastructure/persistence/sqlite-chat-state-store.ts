import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { z } from "zod";

import { chatMemoryLimits } from "../../application/chat/chat-memory-policy.js";
import { boundSessionExchanges, type ChatSessionExchange, type ChatStateSnapshot, type ChatStateStore } from "../../application/chat/chat-state-store.js";
import * as schema from "../database/sqlite-schema.js";

const exchangesSchema = z.array(z.object({
  user: z.object({ content: z.string(), createdAt: z.number() }),
  assistant: z.object({ content: z.string(), createdAt: z.number() }),
}));

// better-sqlite3 is a synchronous driver — drizzle's `.transaction()` for it
// requires the callback to return synchronously (see drizzle-orm/sqlite-core's
// `Result<'sync', T> = T`, vs. `Promise<T>` for async drivers). Every query
// below therefore uses a terminal `.all()`/`.get()`/`.run()` call rather than
// `await`, both inside and outside transactions, for consistency — mirrors
// PostgresChatStateStore's logic, adapted for the sync driver.
export class SqliteChatStateStore implements ChatStateStore {
  public constructor(private readonly database: BetterSQLite3Database<typeof schema>) {}

  public initialize(): Promise<void> { return Promise.resolve(); }

  public load(guildId: string, userId: string, channelId: string, now: number): Promise<ChatStateSnapshot> {
    const session = this.database.select().from(schema.chatSessions).where(and(
      eq(schema.chatSessions.guildId, guildId), eq(schema.chatSessions.userId, userId),
      eq(schema.chatSessions.channelId, channelId),
    )).get();
    const memories = this.database.select().from(schema.chatMemories).where(and(
      eq(schema.chatMemories.guildId, guildId), eq(schema.chatMemories.assertedByUserId, userId),
    )).all();
    const exchanges = session && now - session.updatedAt.getTime() <= chatMemoryLimits.sessionTtlMs
      ? exchangesSchema.parse(session.exchanges)
      : [];
    return Promise.resolve({
      exchanges,
      memories: memories.map((memory) => ({
        id: memory.id,
        assertedByUserId: memory.assertedByUserId,
        subjectUserId: memory.subjectUserId,
        topic: memory.topic,
        slot: memory.slot,
        statement: memory.statement,
        updatedAt: memory.updatedAt.getTime(),
        embedding: memory.embedding,
      })),
    });
  }

  public forgetMemory(guildId: string, userId: string, memoryId: string): Promise<boolean> {
    const result = this.database.delete(schema.chatMemories).where(and(
      eq(schema.chatMemories.guildId, guildId),
      eq(schema.chatMemories.assertedByUserId, userId),
      eq(schema.chatMemories.id, memoryId),
    )).returning({ id: schema.chatMemories.id }).all();
    return Promise.resolve(result.length > 0);
  }

  public forgetAllMemories(guildId: string, userId: string): Promise<number> {
    const result = this.database.delete(schema.chatMemories).where(and(
      eq(schema.chatMemories.guildId, guildId),
      eq(schema.chatMemories.assertedByUserId, userId),
    )).returning({ id: schema.chatMemories.id }).all();
    return Promise.resolve(result.length);
  }

  public purgeUser(guildId: string, userId: string): Promise<void> {
    this.database.transaction((transaction) => {
      transaction.delete(schema.chatSessions).where(and(
        eq(schema.chatSessions.guildId, guildId), eq(schema.chatSessions.userId, userId),
      )).run();
      transaction.delete(schema.dmNotesPreferences).where(and(
        eq(schema.dmNotesPreferences.guildId, guildId), eq(schema.dmNotesPreferences.userId, userId),
      )).run();
      transaction.delete(schema.chatMemories).where(and(
        eq(schema.chatMemories.guildId, guildId), eq(schema.chatMemories.assertedByUserId, userId),
      )).run();
    });
    return Promise.resolve();
  }

  public getDmNotesEnabled(guildId: string, userId: string): Promise<boolean> {
    const preference = this.database.select({ dmNotesEnabled: schema.dmNotesPreferences.dmNotesEnabled })
      .from(schema.dmNotesPreferences)
      .where(and(eq(schema.dmNotesPreferences.guildId, guildId), eq(schema.dmNotesPreferences.userId, userId)))
      .get();
    return Promise.resolve(preference?.dmNotesEnabled ?? true);
  }

  public setDmNotesEnabled(guildId: string, userId: string, enabled: boolean): Promise<void> {
    this.database.insert(schema.dmNotesPreferences).values({
      guildId, userId, dmNotesEnabled: enabled, updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.dmNotesPreferences.guildId, schema.dmNotesPreferences.userId],
      set: { dmNotesEnabled: enabled },
    }).run();
    return Promise.resolve();
  }

  public commitSuccessfulExchange(
    input: Parameters<ChatStateStore["commitSuccessfulExchange"]>[0],
  ): Promise<{ droppedExchanges: readonly ChatSessionExchange[] }> {
    const dropped = this.database.transaction((transaction) => {
      const session = transaction.select().from(schema.chatSessions).where(and(
        eq(schema.chatSessions.guildId, input.guildId), eq(schema.chatSessions.userId, input.userId),
        eq(schema.chatSessions.channelId, input.channelId),
      )).get();
      const prior: ChatSessionExchange[] = session && input.now - session.updatedAt.getTime() <= chatMemoryLimits.sessionTtlMs
        ? exchangesSchema.parse(session.exchanges)
        : [];
      const bounded = boundSessionExchanges([...prior, {
        user: { content: input.userMessage, createdAt: input.now },
        assistant: { content: input.assistantMessage, createdAt: input.now },
      }]);
      transaction.insert(schema.chatSessions).values({
        guildId: input.guildId, userId: input.userId, channelId: input.channelId, exchanges: bounded.kept, updatedAt: new Date(input.now),
      }).onConflictDoUpdate({
        target: [schema.chatSessions.guildId, schema.chatSessions.userId, schema.chatSessions.channelId],
        set: { exchanges: bounded.kept, updatedAt: new Date(input.now) },
      }).run();

      this.applyMemoryActionsInTransaction(transaction, input.guildId, input.userId, input.actions, input.now);
      return bounded.dropped;
    });
    return Promise.resolve({ droppedExchanges: dropped });
  }

  public applyMemoryActions(input: Parameters<ChatStateStore["applyMemoryActions"]>[0]): Promise<void> {
    this.database.transaction((transaction) => {
      this.applyMemoryActionsInTransaction(transaction, input.guildId, input.userId, input.actions, input.now);
    });
    return Promise.resolve();
  }

  private applyMemoryActionsInTransaction(
    transaction: BetterSQLite3Database<typeof schema>,
    guildId: string,
    userId: string,
    actions: Parameters<ChatStateStore["applyMemoryActions"]>[0]["actions"],
    now: number,
  ): void {
    for (const action of actions) {
      const identity = and(
        eq(schema.chatMemories.guildId, guildId),
        eq(schema.chatMemories.assertedByUserId, userId),
        eq(schema.chatMemories.subjectUserId, action.subjectUserId),
        eq(schema.chatMemories.topic, action.topic),
        eq(schema.chatMemories.slot, action.slot),
      );
      if (action.action === "remove") {
        transaction.delete(schema.chatMemories).where(identity).run();
        continue;
      }
      const existing = transaction.select({ id: schema.chatMemories.id }).from(schema.chatMemories).where(identity).get();
      if (!existing) {
        const count = transaction.select({ id: schema.chatMemories.id }).from(schema.chatMemories).where(and(
          eq(schema.chatMemories.guildId, guildId),
          eq(schema.chatMemories.assertedByUserId, userId),
        )).all().length;
        if (count >= chatMemoryLimits.maxRecords) {
          const oldest = transaction.select({ id: schema.chatMemories.id }).from(schema.chatMemories).where(and(
            eq(schema.chatMemories.guildId, guildId),
            eq(schema.chatMemories.assertedByUserId, userId),
          )).orderBy(asc(schema.chatMemories.updatedAt)).limit(1).get();
          if (oldest) transaction.delete(schema.chatMemories).where(eq(schema.chatMemories.id, oldest.id)).run();
        }
      }
      transaction.insert(schema.chatMemories).values({
        id: existing?.id ?? randomUUID(),
        guildId,
        assertedByUserId: userId,
        subjectUserId: action.subjectUserId,
        topic: action.topic,
        slot: action.slot,
        statement: action.statement!,
        embedding: action.embedding,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      }).onConflictDoUpdate({
        target: [
          schema.chatMemories.guildId, schema.chatMemories.assertedByUserId,
          schema.chatMemories.subjectUserId, schema.chatMemories.topic, schema.chatMemories.slot,
        ],
        set: { statement: action.statement!, embedding: action.embedding, updatedAt: new Date(now) },
      }).run();
    }
  }
}
