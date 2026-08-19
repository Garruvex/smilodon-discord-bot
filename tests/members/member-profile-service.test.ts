import { describe, expect, it } from "vitest";

import { MemberProfileService } from "../../src/application/members/member-profile-service.js";
import type { ChatStateStore } from "../../src/application/chat/chat-state-store.js";
import type { BirthdayStore } from "../../src/application/birthdays/birthday-store.js";
import type { UserCustomizationStore } from "../../src/application/chat/user-customization-store.js";

function stubChatStateStore(): ChatStateStore {
  return {
    initialize: () => Promise.resolve(),
    load: () => Promise.resolve({
      exchanges: [],
      memories: [{
        id: "m1", assertedByUserId: "user", subjectUserId: "user",
        topic: "preference", slot: "food.fruit", statement: "likes green apples", updatedAt: 0,
      }],
    }),
    commitSuccessfulExchange: () => Promise.resolve(),
    applyMemoryActions: () => Promise.resolve(),
    forgetMemory: () => Promise.resolve(false),
    forgetAllMemories: () => Promise.resolve(0),
    getDmNotesEnabled: () => Promise.resolve(true),
    setDmNotesEnabled: () => Promise.resolve(),
  };
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
    const service = new MemberProfileService(stubChatStateStore(), birthdayStore, customizationStore);

    const profile = await service.load("guild", "user", Date.now());
    expect(profile.memories).toHaveLength(1);
    expect(profile.birthday).toEqual({ userId: "user", month: 3, day: 5 });
    expect(profile.customization).toBe("Call me 阿龍.");
  });

  it("degrades gracefully when birthdayStore and userCustomizationStore are null", async () => {
    const service = new MemberProfileService(stubChatStateStore(), null, null);
    const profile = await service.load("guild", "user", Date.now());
    expect(profile.memories).toHaveLength(1);
    expect(profile.birthday).toBeNull();
    expect(profile.customization).toBeNull();
  });
});
