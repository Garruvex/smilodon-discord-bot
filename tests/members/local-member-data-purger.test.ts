import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteChatStateStore } from "../../src/infrastructure/persistence/sqlite-chat-state-store.js";
import { LocalUserCustomizationStore } from "../../src/infrastructure/persistence/local-user-customization-store.js";
import { LocalBirthdayStore } from "../../src/infrastructure/persistence/local-birthday-store.js";
import { LocalReminderStore } from "../../src/infrastructure/persistence/local-reminder-store.js";
import { LocalMemberDataPurger } from "../../src/infrastructure/persistence/local-member-data-purger.js";
import { SqlitePersonalMemoryExtractionQueueStore } from "../../src/infrastructure/persistence/sqlite-personal-memory-extraction-queue-store.js";
import type { MemoryRepository, RepositoryIngestInput } from "../../src/application/memory/memory.js";

function ingestInput(overrides: Partial<RepositoryIngestInput> = {}): RepositoryIngestInput {
  return {
    guildId: "guild", kind: "fact", audience: "private", ownerUserId: "user", channelId: "channel",
    isolationChannelId: null, subjectType: "member", subjectId: "user", topic: "preference", slot: "favorite_color",
    statement: "likes blue", status: "active", source: "explicit", confidence: 1, importance: 1,
    embedding: null, embeddingModel: null, expiresAt: null, now: 1_000,
    sourceMessageId: "m1", sourceChannelId: "channel", assertedByUserId: "user",
    ...overrides,
  };
}

// Regression coverage for the P1 finding: retainMemberDataOnLeave: false used
// to be a complete no-op on the local (file-based) backend, because
// MemberDepartureService only knew how to talk to the Postgres-only
// GuildMemberRegistry. This exercises the real local stores end to end.
describe("LocalMemberDataPurger", () => {
  it("deletes memories, customization, birthday, chat state, and reminders (fired or not) for the user", async () => {
    const directory = mkdtempSync(join(tmpdir(), "member-purge-"));
    const connection = createSqliteDatabaseConnection(directory);
    const memoryRepository = new SqliteMemoryRepository(connection.database);
    const userCustomizationStore = new LocalUserCustomizationStore(directory);
    const birthdayStore = new LocalBirthdayStore(directory);
    const reminderStore = new LocalReminderStore(directory);
    const chatStateStore = new SqliteChatStateStore(connection.database);
    const extractionQueueStore = new SqlitePersonalMemoryExtractionQueueStore(connection.database);
    await userCustomizationStore.initialize();
    await birthdayStore.initialize();
    await reminderStore.initialize();

    await memoryRepository.ingest(ingestInput());
    const sharedMemory = await memoryRepository.ingest(ingestInput({
      audience: "guild", ownerUserId: null, channelId: null,
      slot: "shared_favorite_color", source: "consolidation",
    }));
    // Still holds this user's own raw message text — must be purged too,
    // or it can later (re)create a private memory for someone who asked to
    // be forgotten (see PersonalMemoryExtractionQueueStore).
    await extractionQueueStore.enqueueMany([{
      guildId: "guild", channelId: "channel", batchId: "batch-1", subjectId: "user",
      displayName: "User", content: "I like blue",
    }], 1_000);
    await userCustomizationStore.save("guild", "user", "loves markdown");
    await birthdayStore.setBirthday("guild", "user", 3, 14);
    await chatStateStore.commitSuccessfulExchange({
      guildId: "guild", userId: "user", channelId: "channel",
      userMessage: "hi", assistantMessage: "hello", actions: [], now: 1_000,
    });
    await chatStateStore.setDmNotesEnabled("guild", "user", false);
    await chatStateStore.applyMemoryActions({
      guildId: "guild", userId: "user", channelId: "channel",
      actions: [{ action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes apples", embedding: null }],
      now: 1_000,
    });
    const active = await reminderStore.create({
      guildId: "guild", userId: "user", channelId: "channel", message: "stretch", delivery: "channel", dueAt: 9_999,
    });
    const fired = await reminderStore.create({
      guildId: "guild", userId: "user", channelId: "channel", message: "already fired", delivery: "channel", dueAt: 1,
    });
    await reminderStore.markFired(fired.id);

    const purger = new LocalMemberDataPurger(
      memoryRepository, userCustomizationStore, birthdayStore, reminderStore, chatStateStore, extractionQueueStore,
    );
    await purger.purge("guild", "user");

    expect(await memoryRepository.listByUser("guild", "user")).toHaveLength(0);
    expect(await memoryRepository.findById("guild", sharedMemory.id)).not.toBeNull();
    expect(await userCustomizationStore.load("guild", "user")).toBeNull();
    expect(await birthdayStore.getBirthday("guild", "user")).toBeNull();
    expect(await reminderStore.listForUser("guild", "user")).toHaveLength(0);
    expect((await chatStateStore.load("guild", "user", "channel", 1_000)).exchanges).toHaveLength(0);
    expect((await chatStateStore.load("guild", "user", "channel", 1_000)).memories).toHaveLength(0);
    expect(await chatStateStore.getDmNotesEnabled("guild", "user")).toBe(true); // back to the unset default
    // deleteForUser (unlike listForUser) sees fired reminders too — a second
    // call returning 0 proves the fired one was actually removed by the
    // purge, not just excluded from listForUser's active-only view.
    expect(active.id).not.toBe(fired.id);
    expect(await reminderStore.deleteForUser("guild", "user")).toBe(0);
    await expect(extractionQueueStore.dequeueDue(10, 1_000)).resolves.toHaveLength(0);
  });

  it("leaves other users' data untouched", async () => {
    const directory = mkdtempSync(join(tmpdir(), "member-purge-"));
    const connection = createSqliteDatabaseConnection(directory);
    const memoryRepository = new SqliteMemoryRepository(connection.database);
    const userCustomizationStore = new LocalUserCustomizationStore(directory);
    const birthdayStore = new LocalBirthdayStore(directory);
    const reminderStore = new LocalReminderStore(directory);
    const chatStateStore = new SqliteChatStateStore(connection.database);
    const extractionQueueStore = new SqlitePersonalMemoryExtractionQueueStore(connection.database);
    await userCustomizationStore.initialize();
    await birthdayStore.initialize();
    await reminderStore.initialize();

    await memoryRepository.ingest(ingestInput({ ownerUserId: "otherUser", subjectId: "otherUser", assertedByUserId: "otherUser" }));
    await birthdayStore.setBirthday("guild", "otherUser", 6, 1);
    await chatStateStore.setDmNotesEnabled("guild", "otherUser", false);
    await extractionQueueStore.enqueueMany([{
      guildId: "guild", channelId: "channel", batchId: "batch-1", subjectId: "otherUser",
      displayName: "Other User", content: "hello",
    }], 1_000);

    const purger = new LocalMemberDataPurger(
      memoryRepository, userCustomizationStore, birthdayStore, reminderStore, chatStateStore, extractionQueueStore,
    );
    await purger.purge("guild", "user");

    expect(await memoryRepository.listByUser("guild", "otherUser")).toHaveLength(1);
    expect(await birthdayStore.getBirthday("guild", "otherUser")).toEqual({ userId: "otherUser", month: 6, day: 1 });
    expect(await chatStateStore.getDmNotesEnabled("guild", "otherUser")).toBe(false);
    await expect(extractionQueueStore.dequeueDue(10, 1_000)).resolves.toHaveLength(1);
  });

  // Regression coverage for a P2 finding: purge used to await each store
  // sequentially, so one failing store silently stopped the rest from being
  // purged at all. It must attempt every store and only then fail loudly.
  it("still purges the other stores when one store's delete fails, and reports the failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "member-purge-"));
    const connection = createSqliteDatabaseConnection(directory);
    const userCustomizationStore = new LocalUserCustomizationStore(directory);
    const birthdayStore = new LocalBirthdayStore(directory);
    const reminderStore = new LocalReminderStore(directory);
    const chatStateStore = new SqliteChatStateStore(connection.database);
    const extractionQueueStore = new SqlitePersonalMemoryExtractionQueueStore(connection.database);
    await userCustomizationStore.initialize();
    await birthdayStore.initialize();
    await reminderStore.initialize();

    await userCustomizationStore.save("guild", "user", "loves markdown");
    await birthdayStore.setBirthday("guild", "user", 3, 14);
    await extractionQueueStore.enqueueMany([{
      guildId: "guild", channelId: "channel", batchId: "batch-1", subjectId: "user",
      displayName: "User", content: "I like blue",
    }], 1_000);

    const failingMemoryRepository = {
      // Local adapters can throw before returning a promise (for example, a
      // synchronous SQLite or filesystem error), so cover that harder case.
      forget: () => { throw new Error("disk full"); },
    } as unknown as MemoryRepository;

    const purger = new LocalMemberDataPurger(
      failingMemoryRepository, userCustomizationStore, birthdayStore, reminderStore, chatStateStore, extractionQueueStore,
    );

    await expect(purger.purge("guild", "user")).rejects.toThrow(/1 of 6 stores/);
    expect(await userCustomizationStore.load("guild", "user")).toBeNull();
    expect(await birthdayStore.getBirthday("guild", "user")).toBeNull();
    await expect(extractionQueueStore.dequeueDue(10, 1_000)).resolves.toHaveLength(0);
  });
});
