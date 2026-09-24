import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { EmbedBuilder } from "discord.js";

import { MemoryCommand } from "../../src/infrastructure/discord/commands/common/memory-command.js";
import type { ChatStateStore } from "../../src/application/chat/chat-state-store.js";
import type { CommandContext } from "../../src/application/commands/command.js";
import { MemberProfileService } from "../../src/application/members/member-profile-service.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqlitePersonalMemoryExtractionQueueStore } from "../../src/infrastructure/persistence/sqlite-personal-memory-extraction-queue-store.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import type { MemoryEngine, MemoryRepository } from "../../src/application/memory/memory.js";

function testMemoryEngine(): {
  engine: MemoryEngine;
  repository: MemoryRepository;
  extractionQueue: SqlitePersonalMemoryExtractionQueueStore;
} {
  const directory = mkdtempSync(join(tmpdir(), "memory-command-"));
  const connection = createSqliteDatabaseConnection(directory);
  const repository = new SqliteMemoryRepository(connection.database);
  return {
    engine: new DefaultMemoryEngine(repository), repository,
    extractionQueue: new SqlitePersonalMemoryExtractionQueueStore(connection.database),
  };
}

async function seedActiveMemory(repository: MemoryRepository): Promise<void> {
  await repository.ingest({
    guildId: "guild", kind: "preference", audience: "private", ownerUserId: "user", channelId: null,
    isolationChannelId: null, subjectType: "member", subjectId: "user", topic: "preference", slot: "food.fruit",
    statement: "likes green apples", status: "active", source: "live", importance: 1,
    embedding: null, embeddingModel: null, expiresAt: null, now: 0,
    sourceMessageId: null, sourceChannelId: null, assertedByUserId: "user",
  });
}

function baseStore(overrides: Partial<ChatStateStore> = {}): ChatStateStore {
  return {
    initialize: () => Promise.resolve(),
    load: () => Promise.resolve({ exchanges: [], memories: [] }),
    commitSuccessfulExchange: () => Promise.resolve({ droppedExchanges: [] }),
    applyMemoryActions: () => Promise.resolve(),
    forgetMemory: () => Promise.resolve(false),
    forgetAllMemories: () => Promise.resolve(0),
    getDmNotesEnabled: () => Promise.resolve(true),
    setDmNotesEnabled: () => Promise.resolve(),
    purgeUser: () => Promise.resolve(),
    ...overrides,
  };
}

function makeContext(options: {
  subcommand: string;
  id?: string | null;
  all?: boolean | null;
}): { context: CommandContext; reply: ReturnType<typeof vi.fn> } {
  const reply = vi.fn().mockResolvedValue(undefined);
  const context = {
    interaction: {
      guildId: "guild",
      user: { id: "user" },
      options: {
        getSubcommand: () => options.subcommand,
        getString: () => options.id ?? null,
        getBoolean: () => options.all ?? null,
      },
    },
    logger: {} as never,
    responses: { reply } as never,
  } as unknown as CommandContext;
  return { context, reply };
}

describe("MemoryCommand", () => {
  it("lists stored memories with truncated ids", async () => {
    const { engine, repository } = testMemoryEngine();
    await seedActiveMemory(repository);
    const store = baseStore();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine);
    const { context, reply } = makeContext({ subcommand: "list" });

    await command.execute(context);
    expect(reply).toHaveBeenCalledOnce();
    const [payload] = reply.mock.calls[0] as [{ embeds: EmbedBuilder[] }];
    const fields = payload.embeds.flatMap((embed) => embed.toJSON().fields ?? []);
    expect(fields).toContainEqual(expect.objectContaining({ name: "preference.food.fruit" }));
    const field = fields.find((candidate) => candidate.name === "preference.food.fruit");
    expect(field?.value).toContain("likes green apples");
    expect(field?.value).toContain("private");
    expect(field?.value).toContain("active");
    expect(field?.value).toContain("source unavailable");
  });

  it("renders a working view-source link for a live-chat memory with a real Discord message id", async () => {
    const { engine, repository } = testMemoryEngine();
    await repository.ingest({
      guildId: "guild", kind: "preference", audience: "private", ownerUserId: "user", channelId: null,
      isolationChannelId: null, subjectType: "member", subjectId: "user", topic: "preference", slot: "food.fruit",
      statement: "likes green apples", status: "active", source: "live", importance: 1,
      embedding: null, embeddingModel: null, expiresAt: null, now: 0,
      sourceMessageId: "111222333", sourceChannelId: "444555666", assertedByUserId: "user",
    });
    const store = baseStore();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine);
    const { context, reply } = makeContext({ subcommand: "list" });

    await command.execute(context);
    const [payload] = reply.mock.calls[0] as [{ embeds: EmbedBuilder[] }];
    const field = payload.embeds.flatMap((embed) => embed.toJSON().fields ?? [])[0];
    expect(field?.value).toContain("https://discord.com/channels/guild/444555666/111222333");
  });

  it("labels a consolidation-sourced memory (synthetic batch id) as source unavailable, not a broken link", async () => {
    const { engine, repository } = testMemoryEngine();
    await repository.ingest({
      guildId: "guild", kind: "episode", audience: "private", ownerUserId: "user", channelId: null,
      isolationChannelId: null, subjectType: "member", subjectId: "user", topic: "preference", slot: "food.fruit",
      statement: "likes green apples", status: "active", source: "consolidation", importance: 1,
      embedding: null, embeddingModel: null, expiresAt: null, now: 0,
      sourceMessageId: "batch:daily:guild:channel:a-b", sourceChannelId: "channel", assertedByUserId: null,
    });
    const store = baseStore();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine);
    const { context, reply } = makeContext({ subcommand: "list" });

    await command.execute(context);
    const [payload] = reply.mock.calls[0] as [{ embeds: EmbedBuilder[] }];
    const field = payload.embeds.flatMap((embed) => embed.toJSON().fields ?? [])[0];
    expect(field?.value).toContain("source unavailable");
    expect(field?.value).not.toContain("discord.com");
  });

  it("paginates across multiple embeds instead of silently truncating when there are many memories", async () => {
    const { engine, repository } = testMemoryEngine();
    for (let i = 0; i < 30; i++) {
      await repository.ingest({
        guildId: "guild", kind: "fact", audience: "private", ownerUserId: "user", channelId: null,
        isolationChannelId: null, subjectType: "member", subjectId: "user", topic: "preference", slot: `slot${i}`,
        statement: `fact ${i}`, status: "active", source: "live", importance: 1,
        embedding: null, embeddingModel: null, expiresAt: null, now: 0,
        sourceMessageId: null, sourceChannelId: null, assertedByUserId: "user",
      });
    }
    const store = baseStore();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine);
    const { context, reply } = makeContext({ subcommand: "list" });

    await command.execute(context);
    const [payload] = reply.mock.calls[0] as [{ embeds: EmbedBuilder[] }];
    expect(payload.embeds.length).toBeGreaterThan(1);
    const fields = payload.embeds.flatMap((embed) => embed.toJSON().fields ?? []);
    expect(fields).toHaveLength(30);
  });

  it("reports when there is nothing remembered", async () => {
    const { engine } = testMemoryEngine();
    const store = baseStore();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine);
    const { context, reply } = makeContext({ subcommand: "list" });

    await command.execute(context);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("don't have anything remembered"));
  });

  it("forgets a specific memory by matching id prefix", async () => {
    const { engine, repository, extractionQueue } = testMemoryEngine();
    await seedActiveMemory(repository);
    await extractionQueue.enqueueMany([{
      guildId: "guild", channelId: "channel", batchId: "batch-1", subjectId: "user",
      displayName: "User", content: "I like green apples",
    }], 0);
    const [seeded] = await engine.listUserMemories("guild", "user");
    const store = baseStore();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine, extractionQueue);
    const { context, reply } = makeContext({ subcommand: "forget", id: seeded!.id.slice(0, 8) });

    await command.execute(context);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Forgot: preference.food.fruit"));
    expect(await engine.listUserMemories("guild", "user")).toHaveLength(0);
    await expect(extractionQueue.dequeueDue(10, 0)).resolves.toHaveLength(0);
  });

  it("forgets everything when all is true", async () => {
    const { engine, repository } = testMemoryEngine();
    await seedActiveMemory(repository);
    const store = baseStore();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine);
    const { context, reply } = makeContext({ subcommand: "forget", all: true });

    await command.execute(context);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Forgot 1 memory."));
    expect(await engine.listUserMemories("guild", "user")).toHaveLength(0);
  });

  it("forget all:true also clears a third-party guild-knowledge claim about the user, not just what they own", async () => {
    const { engine, repository } = testMemoryEngine();
    await seedActiveMemory(repository);
    // A community claim ABOUT this user, asserted by someone else — no
    // owner of its own (ownerUserId null), so a scope limited to ownerUserId
    // alone would leave it behind even after "forget everything".
    const claimAboutUser = await repository.ingest({
      guildId: "guild", kind: "fact", audience: "guild", ownerUserId: null, channelId: null,
      isolationChannelId: null, subjectType: "member", subjectId: "user", topic: "community_activity",
      slot: "raid.friday", statement: "organizes Friday raids", status: "active", source: "live",
      importance: 1, embedding: null, embeddingModel: null, expiresAt: null, now: 0,
      sourceMessageId: null, sourceChannelId: null, assertedByUserId: "someone-else",
    });
    const store = baseStore();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine);
    const { context, reply } = makeContext({ subcommand: "forget", all: true });

    await command.execute(context);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Forgot 2 memories."));
    expect(await engine.listUserMemories("guild", "user")).toHaveLength(0);
    expect(await repository.findById("guild", claimAboutUser.id)).toBeNull();
  });

  it("forget all:true also clears any queued personal-memory extraction jobs for the user, not just existing memories", async () => {
    // A still-queued (or already-succeeded-but-not-yet-cleaned-up) job
    // holds this user's own raw message text and can later (re)create a
    // private memory for them — see ChannelSummaryScheduler's personal-
    // memory extraction queue. "Forget everything" must clear this too.
    const { engine, repository, extractionQueue } = testMemoryEngine();
    await seedActiveMemory(repository);
    await extractionQueue.enqueueMany([{
      guildId: "guild", channelId: "channel", batchId: "batch-1", subjectId: "user",
      displayName: "User", content: "I like green apples",
    }], 0);
    const store = baseStore();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine, extractionQueue);
    const { context, reply } = makeContext({ subcommand: "forget", all: true });

    await command.execute(context);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Forgot 1 memory."));
    expect(await engine.listUserMemories("guild", "user")).toHaveLength(0);
    await expect(extractionQueue.dequeueDue(10, 0)).resolves.toHaveLength(0);
  });

  it("reports the current dm-notes setting when no value is given", async () => {
    const getDmNotesEnabled = vi.fn().mockResolvedValue(true);
    const store = baseStore({ getDmNotesEnabled });
    const { engine } = testMemoryEngine();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine);
    const { context, reply } = makeContext({ subcommand: "notes" });

    await command.execute(context);
    expect(getDmNotesEnabled).toHaveBeenCalledWith("guild", "user");
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("currently DMed to you"));
  });

  it("turns dm notes off when dm:false is given", async () => {
    const setDmNotesEnabled = vi.fn().mockResolvedValue(undefined);
    const store = baseStore({ setDmNotesEnabled });
    const { engine } = testMemoryEngine();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine);
    const { context, reply } = makeContext({ subcommand: "notes", all: false });

    await command.execute(context);
    expect(setDmNotesEnabled).toHaveBeenCalledWith("guild", "user", false);
    expect(reply).toHaveBeenCalledWith("I won't DM you notes anymore.");
  });

  it("asks for an id or all when forget is called with neither", async () => {
    const { engine } = testMemoryEngine();
    const store = baseStore();
    const command = new MemoryCommand(store, new MemberProfileService(engine, null, null), engine);
    const { context, reply } = makeContext({ subcommand: "forget" });

    await command.execute(context);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Provide `id:"));
  });
});
