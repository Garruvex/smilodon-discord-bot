import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { chatMemoryLimits } from "../../application/chat/chat-memory-policy.js";
import { boundSessionExchanges, type ChatSessionExchange, type ChatStateSnapshot, type ChatStateStore } from "../../application/chat/chat-state-store.js";
import * as schema from "../database/schema.js";
import type { GuildMemberRegistry } from "./guild-member-registry.js";

const exchangesSchema = z.array(z.object({
  user: z.object({ content: z.string(), createdAt: z.number() }),
  assistant: z.object({ content: z.string(), createdAt: z.number() }),
}));

type PgTransaction = Parameters<Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]>[0];

export class PostgresChatStateStore implements ChatStateStore {
  public constructor(
    private readonly database: PostgresJsDatabase<typeof schema>,
    private readonly memberRegistry: GuildMemberRegistry,
  ) {}

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
        updatedAt: memory.updatedAt.getTime(),
      })),
    };
  }

  public async forgetMemory(guildId: string, userId: string, memoryId: string): Promise<boolean> {
    const result = await this.database.delete(schema.chatMemories).where(and(
      eq(schema.chatMemories.guildId, guildId),
      eq(schema.chatMemories.assertedByUserId, userId),
      eq(schema.chatMemories.id, memoryId),
    )).returning({ id: schema.chatMemories.id });
    return result.length > 0;
  }

  public async forgetAllMemories(guildId: string, userId: string): Promise<number> {
    const result = await this.database.delete(schema.chatMemories).where(and(
      eq(schema.chatMemories.guildId, guildId),
      eq(schema.chatMemories.assertedByUserId, userId),
    )).returning({ id: schema.chatMemories.id });
    return result.length;
  }

  public async getDmNotesEnabled(guildId: string, userId: string): Promise<boolean> {
    const sessions = await this.database.select({ dmNotesEnabled: schema.chatSessions.dmNotesEnabled })
      .from(schema.chatSessions)
      .where(and(eq(schema.chatSessions.guildId, guildId), eq(schema.chatSessions.userId, userId)))
      .limit(1);
    return sessions[0]?.dmNotesEnabled ?? true;
  }

  public async setDmNotesEnabled(guildId: string, userId: string, enabled: boolean): Promise<void> {
    const memberId = await this.memberRegistry.resolveMemberId(guildId, userId);
    await this.database.insert(schema.chatSessions).values({
      guildId, userId, memberId, exchanges: [], dmNotesEnabled: enabled, updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.chatSessions.guildId, schema.chatSessions.userId],
      set: { dmNotesEnabled: enabled, memberId },
    });
  }

  public async commitSuccessfulExchange(input: Parameters<ChatStateStore["commitSuccessfulExchange"]>[0]): Promise<void> {
    const memberId = await this.memberRegistry.resolveMemberId(input.guildId, input.userId);
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
        guildId: input.guildId, userId: input.userId, memberId, exchanges, updatedAt: new Date(input.now),
      }).onConflictDoUpdate({
        target: [schema.chatSessions.guildId, schema.chatSessions.userId],
        set: { exchanges, updatedAt: new Date(input.now), memberId },
      });

      await this.applyMemoryActionsInTransaction(transaction, input.guildId, input.userId, memberId, input.actions, input.now);
    });
  }

  public async applyMemoryActions(input: Parameters<ChatStateStore["applyMemoryActions"]>[0]): Promise<void> {
    const memberId = await this.memberRegistry.resolveMemberId(input.guildId, input.userId);
    await this.database.transaction((transaction) =>
      this.applyMemoryActionsInTransaction(transaction, input.guildId, input.userId, memberId, input.actions, input.now),
    );
  }

  private async applyMemoryActionsInTransaction(
    transaction: PgTransaction,
    guildId: string,
    userId: string,
    memberId: string,
    actions: Parameters<ChatStateStore["applyMemoryActions"]>[0]["actions"],
    now: number,
  ): Promise<void> {
    for (const action of actions) {
      const identity = and(
        eq(schema.chatMemories.guildId, guildId),
        eq(schema.chatMemories.assertedByUserId, userId),
        eq(schema.chatMemories.subjectUserId, action.subjectUserId),
        eq(schema.chatMemories.topic, action.topic),
        eq(schema.chatMemories.slot, action.slot),
      );
      if (action.action === "remove") {
        await transaction.delete(schema.chatMemories).where(identity);
        continue;
      }
      const existing = await transaction.select({ id: schema.chatMemories.id }).from(schema.chatMemories).where(identity).limit(1);
      if (existing.length === 0) {
        const count = await transaction.$count(schema.chatMemories, and(
          eq(schema.chatMemories.guildId, guildId),
          eq(schema.chatMemories.assertedByUserId, userId),
        ));
        if (count >= chatMemoryLimits.maxRecords) {
          const oldest = await transaction.select({ id: schema.chatMemories.id }).from(schema.chatMemories).where(and(
            eq(schema.chatMemories.guildId, guildId),
            eq(schema.chatMemories.assertedByUserId, userId),
          )).orderBy(asc(schema.chatMemories.updatedAt)).limit(1);
          if (oldest[0]) await transaction.delete(schema.chatMemories).where(eq(schema.chatMemories.id, oldest[0].id));
        }
      }
      await transaction.insert(schema.chatMemories).values({
        id: existing[0]?.id ?? randomUUID(),
        guildId,
        assertedByUserId: userId,
        memberId,
        subjectUserId: action.subjectUserId,
        topic: action.topic,
        slot: action.slot,
        statement: action.statement!,
        updatedAt: new Date(now),
      }).onConflictDoUpdate({
        target: [
          schema.chatMemories.guildId, schema.chatMemories.assertedByUserId,
          schema.chatMemories.subjectUserId, schema.chatMemories.topic, schema.chatMemories.slot,
        ],
        set: { statement: action.statement!, updatedAt: new Date(now), memberId },
      });
    }
  }
}
