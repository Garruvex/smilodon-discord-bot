import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalChatStateStore } from "../../src/infrastructure/persistence/local-chat-state-store.js";

describe("LocalChatStateStore", () => {
  it("persists session and profile memory in one per-user document", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chat-state-"));
    const store = new LocalChatStateStore(directory);
    await store.initialize();
    await store.commitSuccessfulExchange({
      guildId: "guild", userId: "user", userMessage: "remember", assistantMessage: "okay", now: 100,
      actions: [{
        action: "upsert", subjectUserId: "user", topic: "preference",
        slot: "food.fruit", statement: "likes green apples",
      }],
    });

    const reloaded = new LocalChatStateStore(directory);
    await reloaded.initialize();
    const state = await reloaded.load("guild", "user", 101);
    expect(state.exchanges).toHaveLength(1);
    expect(state.memories).toMatchObject([{ topic: "preference", slot: "food.fruit", statement: "likes green apples" }]);
    expect(JSON.parse(readFileSync(join(directory, "chat", "guild", "users", "user.json"), "utf8"))).toMatchObject({
      version: 1,
      guildId: "guild",
      userId: "user",
    });
  });

  it("upserts the same profile slot rather than appending duplicates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chat-state-"));
    const store = new LocalChatStateStore(directory);
    await store.initialize();
    for (const statement of ["plays tank", "plays healer"]) {
      await store.commitSuccessfulExchange({
        guildId: "guild", userId: "user", userMessage: statement, assistantMessage: "okay", now: Date.now(),
        actions: [{ action: "upsert", subjectUserId: "friend", topic: "gaming", slot: "role.game", statement }],
      });
    }
    const state = await store.load("guild", "user", Date.now());
    expect(state.memories).toHaveLength(1);
    expect(state.memories[0]?.statement).toBe("plays healer");
  });

  it("migrates the legacy aggregate once while retaining the source file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chat-state-"));
    const legacyFile = join(directory, "chat-state.json");
    writeFileSync(legacyFile, JSON.stringify({
      version: 1,
      owners: {
        "guild:user": {
          exchanges: [],
          memories: [{
            id: "memory", assertedByUserId: "user", subjectUserId: "user",
            topic: "preference", slot: "food.fruit", statement: "likes apples", pinned: false,
          }],
          updatedAt: 100,
        },
      },
    }), "utf8");

    const store = new LocalChatStateStore(directory);
    await store.initialize();
    expect((await store.load("guild", "user", 101)).memories[0]?.statement).toBe("likes apples");
    expect(existsSync(legacyFile)).toBe(true);
    expect(existsSync(join(directory, "chat", ".aggregate-v1-migrated"))).toBe(true);
  });

  it("drops whole oldest exchanges to satisfy the total session budget", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chat-state-"));
    const store = new LocalChatStateStore(directory);
    await store.initialize();
    for (let index = 0; index < 8; index += 1) {
      await store.commitSuccessfulExchange({
        guildId: "guild",
        userId: "user",
        userMessage: `user-${index}-${"u".repeat(900)}`,
        assistantMessage: `assistant-${index}-${"a".repeat(1_900)}`,
        actions: [],
        now: 100 + index,
      });
    }
    const state = await store.load("guild", "user", 108);
    expect(state.exchanges.length).toBeLessThan(8);
    expect(JSON.stringify(state.exchanges).length).toBeLessThanOrEqual(16_000);
    expect(state.exchanges.at(-1)?.assistant.content).toBe(`assistant-7-${"a".repeat(1_900)}`);
  });
});
