import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { LocalUserCustomizationStore } from "../../src/infrastructure/persistence/local-user-customization-store.js";
import { LocalBirthdayStore } from "../../src/infrastructure/persistence/local-birthday-store.js";
import { LocalReminderStore } from "../../src/infrastructure/persistence/local-reminder-store.js";
import { LocalMemberDataPurger } from "../../src/infrastructure/persistence/local-member-data-purger.js";
import type { RepositoryIngestInput } from "../../src/application/memory/memory.js";

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
  it("deletes memories, customization, birthday, and reminders for the user", async () => {
    const directory = mkdtempSync(join(tmpdir(), "member-purge-"));
    const connection = createSqliteDatabaseConnection(directory);
    const memoryRepository = new SqliteMemoryRepository(connection.database);
    const userCustomizationStore = new LocalUserCustomizationStore(directory);
    const birthdayStore = new LocalBirthdayStore(directory);
    const reminderStore = new LocalReminderStore(directory);
    await userCustomizationStore.initialize();
    await birthdayStore.initialize();
    await reminderStore.initialize();

    await memoryRepository.ingest(ingestInput());
    await userCustomizationStore.save("guild", "user", "loves markdown");
    await birthdayStore.setBirthday("guild", "user", 3, 14);
    await reminderStore.create({
      guildId: "guild", userId: "user", channelId: "channel", message: "stretch", delivery: "channel", dueAt: 9_999,
    });

    const purger = new LocalMemberDataPurger(memoryRepository, userCustomizationStore, birthdayStore, reminderStore);
    await purger.purge("guild", "user");

    expect(await memoryRepository.listByUser("guild", "user")).toHaveLength(0);
    expect(await userCustomizationStore.load("guild", "user")).toBeNull();
    expect(await birthdayStore.getBirthday("guild", "user")).toBeNull();
    expect(await reminderStore.listForUser("guild", "user")).toHaveLength(0);
  });

  it("leaves other users' data untouched", async () => {
    const directory = mkdtempSync(join(tmpdir(), "member-purge-"));
    const connection = createSqliteDatabaseConnection(directory);
    const memoryRepository = new SqliteMemoryRepository(connection.database);
    const userCustomizationStore = new LocalUserCustomizationStore(directory);
    const birthdayStore = new LocalBirthdayStore(directory);
    const reminderStore = new LocalReminderStore(directory);
    await userCustomizationStore.initialize();
    await birthdayStore.initialize();
    await reminderStore.initialize();

    await memoryRepository.ingest(ingestInput({ ownerUserId: "otherUser", subjectId: "otherUser", assertedByUserId: "otherUser" }));
    await birthdayStore.setBirthday("guild", "otherUser", 6, 1);

    const purger = new LocalMemberDataPurger(memoryRepository, userCustomizationStore, birthdayStore, reminderStore);
    await purger.purge("guild", "user");

    expect(await memoryRepository.listByUser("guild", "otherUser")).toHaveLength(1);
    expect(await birthdayStore.getBirthday("guild", "otherUser")).toEqual({ userId: "otherUser", month: 6, day: 1 });
  });
});
