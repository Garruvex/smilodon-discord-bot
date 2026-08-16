import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { chatMemoryLimits } from "../../application/chat/chat-memory-policy.js";
import { boundSessionExchanges, type ChatSessionExchange, type ChatStateSnapshot, type ChatStateStore } from "../../application/chat/chat-state-store.js";
import * as schema from "../database/schema.js";

const exchangesSchema = z.array(z.object({
  user: z.object({ content: z.string(), createdAt: z.number() }),
  assistant: z.object({ content: z.string(), createdAt: z.number() }),
}));

export class PostgresChatStateStore implements ChatStateStore {
  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public initialize(): Promise<void> { return Promise.resolve(); }

  public async load(guildId: string, userId: string, now: number): Promise<ChatStateSnapshot> {
    const [sessions, memories] = await Promise.all([
      this.database.select().from(schema.chatSessions).where(and(
        eq(schema.chatSessions.guildId, guildId), eq(schema.chatSessions.userId, userId),
      )).limit(1),
      this.database.select().from(schema.chatMemories).where(and(
        eq(schema.chatMemories.guildId, guildId), eq(schema.chatMemories.assertedByUserId, userId),
      )),
    ]);
    const session = sessions[0];
    const exchanges = session && now - session.updatedAt.getTime() <= chatMemoryLimits.sessionTtlMs
      ? exchangesSchema.parse(session.exchanges)
      : [];
    return {
      exchanges,
      memories: memories.map((memory) => ({
        id: memory.id,
        assertedByUserId: memory.assertedByUserId,
        subjectUserId: memory.subjectUserId,
        topic: memory.topic,
        slot: memory.slot,
        statement: memory.statement,
        pinned: memory.pinned,
      })),
    };
  }

  public async commitSuccessfulExchange(input: Parameters<ChatStateStore["commitSuccessfulExchange"]>[0]): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const sessions = await transaction.select().from(schema.chatSessions).where(and(
        eq(schema.chatSessions.guildId, input.guildId), eq(schema.chatSessions.userId, input.userId),
      )).limit(1);
      const session = sessions[0];
      const prior: ChatSessionExchange[] = session && input.now - session.updatedAt.getTime() <= chatMemoryLimits.sessionTtlMs
        ? exchangesSchema.parse(session.exchanges)
        : [];
      const exchanges = boundSessionExchanges([...prior, {
        user: { content: input.userMessage, createdAt: input.now },
        assistant: { content: input.assistantMessage, createdAt: input.now },
      }]);
      await transaction.insert(schema.chatSessions).values({
        guildId: input.guildId, userId: input.userId, exchanges, updatedAt: new Date(input.now),
      }).onConflictDoUpdate({
        target: [schema.chatSessions.guildId, schema.chatSessions.userId],
        set: { exchanges, updatedAt: new Date(input.now) },
      });

      for (const action of input.actions) {
        const identity = and(
          eq(schema.chatMemories.guildId, input.guildId),
          eq(schema.chatMemories.assertedByUserId, input.userId),
          eq(schema.chatMemories.subjectUserId, action.subjectUserId),
          eq(schema.chatMemories.topic, action.topic),
          eq(schema.chatMemories.slot, action.slot),
        );
        if (action.action === "remove") {
          await transaction.delete(schema.chatMemories).where(and(identity, eq(schema.chatMemories.pinned, false)));
          continue;
        }
        const count = await transaction.$count(schema.chatMemories, and(
          eq(schema.chatMemories.guildId, input.guildId),
          eq(schema.chatMemories.assertedByUserId, input.userId),
        ));
        const existing = await transaction.select({ id: schema.chatMemories.id }).from(schema.chatMemories).where(identity).limit(1);
        if (existing.length === 0 && count >= chatMemoryLimits.maxRecords) continue;
        await transaction.insert(schema.chatMemories).values({
          id: existing[0]?.id ?? randomUUID(),
          guildId: input.guildId,
          assertedByUserId: input.userId,
          subjectUserId: action.subjectUserId,
          topic: action.topic,
          slot: action.slot,
          statement: action.statement!,
          updatedAt: new Date(input.now),
        }).onConflictDoUpdate({
          target: [
            schema.chatMemories.guildId, schema.chatMemories.assertedByUserId,
            schema.chatMemories.subjectUserId, schema.chatMemories.topic, schema.chatMemories.slot,
          ],
          set: { statement: action.statement!, updatedAt: new Date(input.now) },
        });
      }
    });
  }
}
