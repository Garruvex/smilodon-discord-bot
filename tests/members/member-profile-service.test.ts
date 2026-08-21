import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemberProfileService } from "../../src/application/members/member-profile-service.js";
import type { BirthdayStore } from "../../src/application/birthdays/birthday-store.js";
import type { UserCustomizationStore } from "../../src/application/chat/user-customization-store.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import type { MemoryEngine } from "../../src/application/memory/memory.js";

async function seededMemoryEngine(): Promise<MemoryEngine> {
  const directory = mkdtempSync(join(tmpdir(), "member-profile-service-"));
  const connection = createSqliteDatabaseConnection(directory);
  const repository = new SqliteMemoryRepository(connection.database);
  await repository.ingest({
    guildId: "guild", kind: "preference", audience: "private", ownerUserId: "user", channelId: null,
    isolationChannelId: null, subjectType: "member", subjectId: "user", topic: "preference", slot: "food.fruit",
    statement: "likes green apples", status: "active", source: "live", confidence: 1, importance: 1,
    embedding: null, embeddingModel: null, expiresAt: null, now: 0,
    sourceMessageId: null, sourceChannelId: null, assertedByUserId: "user",
  });
  return new DefaultMemoryEngine(repository);
}

describe("MemberProfileService", () => {
  it("assembles memories, birthday, and customization in one call", async () => {
    const birthdayStore: BirthdayStore = {
      initialize: () => Promise.resolve(),
      setBirthday: () => Promise.resolve(),
      removeBirthday: () => Promise.resolve(false),
      getBirthday: () => Promise.resolve({ userId: "user", month: 3, day: 5 }),
      listForGuildOnDate: () => Promise.resolve([]),
      hasAnnounced: () => Promise.resolve(false),
      markAnnounced: () => Promise.resolve(),
    };
    const customizationStore: UserCustomizationStore = {
      initialize: () => Promise.resolve(),
      load: () => Promise.resolve("Call me 阿龍."),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    const service = new MemberProfileService(await seededMemoryEngine(), birthdayStore, customizationStore);

    const profile = await service.load("guild", "user");
    expect(profile.memories).toHaveLength(1);
    expect(profile.birthday).toEqual({ userId: "user", month: 3, day: 5 });
    expect(profile.customization).toBe("Call me 阿龍.");
  });

  it("degrades gracefully when birthdayStore and userCustomizationStore are null", async () => {
    const service = new MemberProfileService(await seededMemoryEngine(), null, null);
    const profile = await service.load("guild", "user");
    expect(profile.memories).toHaveLength(1);
    expect(profile.birthday).toBeNull();
    expect(profile.customization).toBeNull();
  });
});
