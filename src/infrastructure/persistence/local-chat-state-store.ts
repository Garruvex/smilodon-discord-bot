import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { chatMemoryLimits } from "../../application/chat/chat-memory-policy.js";
import type { ChatMemoryRecord } from "../../application/chat/chat-provider.js";
import { boundSessionExchanges, type ChatStateSnapshot, type UserChatStateStore } from "../../application/chat/chat-state-store.js";

const exchangeSchema = z.object({
  user: z.object({ content: z.string(), createdAt: z.number() }),
  assistant: z.object({ content: z.string(), createdAt: z.number() }),
});
const memorySchema = z.object({
  id: z.string(), assertedByUserId: z.string(), subjectUserId: z.string(),
  topic: z.string(), slot: z.string(), statement: z.string(), pinned: z.boolean(),
});
const userDocumentSchema = z.object({
  version: z.literal(1), guildId: z.string(), userId: z.string(),
  exchanges: z.array(exchangeSchema).default([]), memories: z.array(memorySchema).default([]), updatedAt: z.number(),
  dmNotesEnabled: z.boolean().default(true),
});
const aggregateSchema = z.object({
  version: z.literal(1),
  owners: z.record(z.string(), z.object({
    exchanges: z.array(exchangeSchema).default([]), memories: z.array(memorySchema).default([]), updatedAt: z.number(),
  })),
});
type UserDocument = z.infer<typeof userDocumentSchema>;

export class LocalChatStateStore implements UserChatStateStore {
  private readonly chatRoot: string;
  private readonly legacyAggregateFile: string;
  private readonly migrationMarker: string;

  public constructor(runtimeDataDirectory: string) {
    this.chatRoot = resolve(runtimeDataDirectory, "chat");
    this.legacyAggregateFile = resolve(runtimeDataDirectory, "chat-state.json");
    this.migrationMarker = resolve(this.chatRoot, ".aggregate-v1-migrated");
    mkdirSync(this.chatRoot, { recursive: true });
  }

  public initialize(): Promise<void> {
    this.migrateAggregateIfNeeded();
    return Promise.resolve();
  }

  public load(guildId: string, userId: string, now: number): Promise<ChatStateSnapshot> {
    const state = this.read(guildId, userId);
    if (!state) return Promise.resolve({ exchanges: [], memories: [] });
    const exchanges = now - state.updatedAt > chatMemoryLimits.sessionTtlMs ? [] : state.exchanges;
    return Promise.resolve({ exchanges: structuredClone(exchanges), memories: structuredClone(state.memories) });
  }

  public commitSuccessfulExchange(input: Parameters<UserChatStateStore["commitSuccessfulExchange"]>[0]): Promise<void> {
    const current = this.read(input.guildId, input.userId) ?? {
      version: 1 as const, guildId: input.guildId, userId: input.userId,
      exchanges: [], memories: [], updatedAt: input.now, dmNotesEnabled: true,
    };
    const exchanges = boundSessionExchanges([
      ...(input.now - current.updatedAt > chatMemoryLimits.sessionTtlMs ? [] : current.exchanges),
      { user: { content: input.userMessage, createdAt: input.now }, assistant: { content: input.assistantMessage, createdAt: input.now } },
    ]);
    const memories = [...current.memories];
    for (const action of input.actions) {
      const index = memories.findIndex((memory) =>
        memory.subjectUserId === action.subjectUserId && memory.topic === action.topic && memory.slot === action.slot,
      );
      if (action.action === "remove") {
        if (index >= 0 && !memories[index]!.pinned) memories.splice(index, 1);
        continue;
      }
      const record: ChatMemoryRecord = {
        id: index >= 0 ? memories[index]!.id : randomUUID(), assertedByUserId: input.userId,
        subjectUserId: action.subjectUserId, topic: action.topic, slot: action.slot,
        statement: action.statement!, pinned: index >= 0 ? memories[index]!.pinned : false,
      };
      if (index >= 0) memories[index] = record;
      else if (memories.length < chatMemoryLimits.maxRecords) memories.push(record);
    }
    this.write({
      version: 1, guildId: input.guildId, userId: input.userId, exchanges, memories,
      updatedAt: input.now, dmNotesEnabled: current.dmNotesEnabled,
    });
    return Promise.resolve();
  }

  public getDmNotesEnabled(guildId: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.read(guildId, userId)?.dmNotesEnabled ?? true);
  }

  public setDmNotesEnabled(guildId: string, userId: string, enabled: boolean): Promise<void> {
    const current = this.read(guildId, userId) ?? {
      version: 1 as const, guildId, userId, exchanges: [], memories: [], updatedAt: Date.now(), dmNotesEnabled: true,
    };
    this.write({ ...current, dmNotesEnabled: enabled });
    return Promise.resolve();
  }

  public forgetMemory(guildId: string, userId: string, memoryId: string): Promise<boolean> {
    const state = this.read(guildId, userId);
    if (!state) return Promise.resolve(false);
    const index = state.memories.findIndex((memory) => memory.id === memoryId);
    if (index < 0) return Promise.resolve(false);
    state.memories.splice(index, 1);
    this.write(state);
    return Promise.resolve(true);
  }

  public forgetAllMemories(guildId: string, userId: string): Promise<number> {
    const state = this.read(guildId, userId);
    if (!state || state.memories.length === 0) return Promise.resolve(0);
    const count = state.memories.length;
    state.memories = [];
    this.write(state);
    return Promise.resolve(count);
  }

  private read(guildId: string, userId: string): UserDocument | null {
    const file = this.userFile(guildId, userId);
    if (!existsSync(file)) return null;
    try {
      return userDocumentSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new Error(`Unable to read user chat state "${file}".`, { cause: error });
    }
  }

  private write(document: UserDocument): void {
    const file = this.userFile(document.guildId, document.userId);
    mkdirSync(dirname(file), { recursive: true });
    const temporaryFile = `${file}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temporaryFile, file);
  }

  private userFile(guildId: string, userId: string): string {
    return resolve(this.chatRoot, safeSegment(guildId), "users", `${safeSegment(userId)}.json`);
  }

  private migrateAggregateIfNeeded(): void {
    if (existsSync(this.migrationMarker)) return;
    if (existsSync(this.legacyAggregateFile)) {
      let aggregate: z.infer<typeof aggregateSchema>;
      try {
        aggregate = aggregateSchema.parse(JSON.parse(readFileSync(this.legacyAggregateFile, "utf8")));
      } catch (error) {
        throw new Error(`Unable to migrate chat state "${this.legacyAggregateFile}".`, { cause: error });
      }
      for (const [ownerKey, state] of Object.entries(aggregate.owners)) {
        const separator = ownerKey.indexOf(":");
        if (separator <= 0 || separator === ownerKey.length - 1) throw new Error(`Invalid legacy chat owner key "${ownerKey}".`);
        const guildId = ownerKey.slice(0, separator);
        const userId = ownerKey.slice(separator + 1);
        if (!this.read(guildId, userId)) this.write({ version: 1, guildId, userId, dmNotesEnabled: true, ...state });
      }
    }
    writeFileSync(this.migrationMarker, "aggregate-v1 migrated; legacy file retained\n", "utf8");
  }
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error(`Unsafe chat-state identifier "${value}".`);
  return value;
}
