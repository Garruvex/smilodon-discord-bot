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

  it("defaults dm notes to enabled and persists a change across reloads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chat-state-"));
    const store = new LocalChatStateStore(directory);
    await store.initialize();

    expect(await store.getDmNotesEnabled("guild", "user")).toBe(true);
    await store.setDmNotesEnabled("guild", "user", false);
    expect(await store.getDmNotesEnabled("guild", "user")).toBe(false);

    const reloaded = new LocalChatStateStore(directory);
    await reloaded.initialize();
    expect(await reloaded.getDmNotesEnabled("guild", "user")).toBe(false);
  });

  it("keeps the dm notes preference when a later exchange is committed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chat-state-"));
    const store = new LocalChatStateStore(directory);
    await store.initialize();
    await store.setDmNotesEnabled("guild", "user", false);

    await store.commitSuccessfulExchange({
      guildId: "guild", userId: "user", userMessage: "hi", assistantMessage: "hello", now: 100, actions: [],
    });

    expect(await store.getDmNotesEnabled("guild", "user")).toBe(false);
  });

  it("forgets a single memory by id, including pinned ones", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chat-state-"));
    const store = new LocalChatStateStore(directory);
    await store.initialize();
    await store.commitSuccessfulExchange({
      guildId: "guild", userId: "user", userMessage: "remember", assistantMessage: "okay", now: 100,
      actions: [{ action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" }],
    });
    const before = await store.load("guild", "user", 101);
    const memoryId = before.memories[0]!.id;

    expect(await store.forgetMemory("guild", "user", "not-a-real-id")).toBe(false);
    expect(await store.forgetMemory("guild", "user", memoryId)).toBe(true);

    const after = await store.load("guild", "user", 101);
    expect(after.memories).toHaveLength(0);
  });

  it("forgets every memory for a user and reports how many were removed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chat-state-"));
    const store = new LocalChatStateStore(directory);
    await store.initialize();
    await store.commitSuccessfulExchange({
      guildId: "guild", userId: "user", userMessage: "remember", assistantMessage: "okay", now: 100,
      actions: [
        { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples" },
        { action: "upsert", subjectUserId: "user", topic: "identity", slot: "role", statement: "is a moderator" },
      ],
    });

    expect(await store.forgetAllMemories("guild", "user")).toBe(2);
    expect(await store.forgetAllMemories("guild", "user")).toBe(0);
    expect((await store.load("guild", "user", 101)).memories).toHaveLength(0);
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
