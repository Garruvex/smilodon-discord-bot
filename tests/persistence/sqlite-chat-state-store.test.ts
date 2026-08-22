import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteChatStateStore } from "../../src/infrastructure/persistence/sqlite-chat-state-store.js";

function store(): SqliteChatStateStore {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-chat-state-"));
  const connection = createSqliteDatabaseConnection(directory);
  return new SqliteChatStateStore(connection.database);
}

describe("SqliteChatStateStore", () => {
  it("persists a session exchange and a profile memory", async () => {
    const chatStateStore = store();
    await chatStateStore.commitSuccessfulExchange({
      guildId: "guild", userId: "user", channelId: "channel", userMessage: "remember", assistantMessage: "okay", now: 100,
      actions: [{
        action: "upsert", subjectUserId: "user", topic: "preference",
        slot: "food.fruit", statement: "likes green apples", embedding: null,
      }],
    });

    const state = await chatStateStore.load("guild", "user", "channel", 101);
    expect(state.exchanges).toHaveLength(1);
    expect(state.memories).toMatchObject([{ topic: "preference", slot: "food.fruit", statement: "likes green apples" }]);
  });

  it("keeps a user's recent-exchange history isolated per channel", async () => {
    const chatStateStore = store();
    await chatStateStore.commitSuccessfulExchange({
      guildId: "guild", userId: "user", channelId: "channel-a", userMessage: "hi a", assistantMessage: "hello a", now: 100, actions: [],
    });

    const stateA = await chatStateStore.load("guild", "user", "channel-a", 101);
    const stateB = await chatStateStore.load("guild", "user", "channel-b", 101);
    expect(stateA.exchanges).toHaveLength(1);
    expect(stateB.exchanges).toHaveLength(0);
  });

  it("upserts the same profile slot rather than appending duplicates", async () => {
    const chatStateStore = store();
    for (const statement of ["plays tank", "plays healer"]) {
      await chatStateStore.commitSuccessfulExchange({
        guildId: "guild", userId: "user", channelId: "channel", userMessage: statement, assistantMessage: "okay", now: Date.now(),
        actions: [{ action: "upsert", subjectUserId: "friend", topic: "gaming", slot: "role.game", statement, embedding: null }],
      });
    }
    const state = await chatStateStore.load("guild", "user", "channel", Date.now());
    expect(state.memories).toHaveLength(1);
    expect(state.memories[0]?.statement).toBe("plays healer");
  });

  it("defaults dm notes to enabled, keyed per user regardless of channel", async () => {
    const chatStateStore = store();
    expect(await chatStateStore.getDmNotesEnabled("guild", "user")).toBe(true);
    await chatStateStore.setDmNotesEnabled("guild", "user", false);
    expect(await chatStateStore.getDmNotesEnabled("guild", "user")).toBe(false);

    await chatStateStore.commitSuccessfulExchange({
      guildId: "guild", userId: "user", channelId: "channel", userMessage: "hi", assistantMessage: "hello", now: 100, actions: [],
    });
    expect(await chatStateStore.getDmNotesEnabled("guild", "user")).toBe(false);
  });

  it("applies memory actions without writing a session exchange", async () => {
    const chatStateStore = store();
    await chatStateStore.applyMemoryActions({
      guildId: "guild", userId: "user", channelId: "channel", now: 100,
      actions: [{ action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples", embedding: null }],
    });

    const state = await chatStateStore.load("guild", "user", "channel", 101);
    expect(state.exchanges).toHaveLength(0);
    expect(state.memories).toMatchObject([{ topic: "preference", slot: "food.fruit", statement: "likes green apples" }]);
  });

  it("removes a memory via applyMemoryActions", async () => {
    const chatStateStore = store();
    await chatStateStore.applyMemoryActions({
      guildId: "guild", userId: "user", channelId: "channel", now: 100,
      actions: [{ action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples", embedding: null }],
    });
    await chatStateStore.applyMemoryActions({
      guildId: "guild", userId: "user", channelId: "channel", now: 101,
      actions: [{ action: "remove", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: null, embedding: null }],
    });

    expect((await chatStateStore.load("guild", "user", "channel", 102)).memories).toHaveLength(0);
  });

  it("forgets a single memory by id and all memories at once", async () => {
    const chatStateStore = store();
    await chatStateStore.commitSuccessfulExchange({
      guildId: "guild", userId: "user", channelId: "channel", userMessage: "remember", assistantMessage: "okay", now: 100,
      actions: [
        { action: "upsert", subjectUserId: "user", topic: "preference", slot: "food.fruit", statement: "likes green apples", embedding: null },
        { action: "upsert", subjectUserId: "user", topic: "identity", slot: "role", statement: "is a moderator", embedding: null },
      ],
    });
    const before = await chatStateStore.load("guild", "user", "channel", 101);
    const firstId = before.memories[0]!.id;

    expect(await chatStateStore.forgetMemory("guild", "user", "not-a-real-id")).toBe(false);
    expect(await chatStateStore.forgetMemory("guild", "user", firstId)).toBe(true);
    expect((await chatStateStore.load("guild", "user", "channel", 101)).memories).toHaveLength(1);

    expect(await chatStateStore.forgetAllMemories("guild", "user")).toBe(1);
    expect(await chatStateStore.forgetAllMemories("guild", "user")).toBe(0);
  });

  it("reports dropped exchanges once the session exceeds the exchange cap", async () => {
    const chatStateStore = store();
    let lastDropped: unknown[] = [];
    for (let index = 0; index < 9; index += 1) {
      const result = await chatStateStore.commitSuccessfulExchange({
        guildId: "guild", userId: "user", channelId: "channel", userMessage: `m${index}`, assistantMessage: "ok", now: 100 + index, actions: [],
      });
      lastDropped = [...result.droppedExchanges];
    }
    const state = await chatStateStore.load("guild", "user", "channel", 200);
    expect(state.exchanges).toHaveLength(8);
    expect(lastDropped).toHaveLength(1);
  });

  it("survives two concurrent writers for the same guild+user without losing either update (the JSON backend's race)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sqlite-chat-state-"));
    const connection = createSqliteDatabaseConnection(directory);
    const chatStateStore = new SqliteChatStateStore(connection.database);
    await Promise.all([
      chatStateStore.applyMemoryActions({
        guildId: "guild", userId: "user", channelId: "channel", now: 100,
        actions: [{ action: "upsert", subjectUserId: "user", topic: "preference", slot: "a", statement: "one", embedding: null }],
      }),
      chatStateStore.applyMemoryActions({
        guildId: "guild", userId: "user", channelId: "channel", now: 100,
        actions: [{ action: "upsert", subjectUserId: "user", topic: "preference", slot: "b", statement: "two", embedding: null }],
      }),
    ]);
    const state = await chatStateStore.load("guild", "user", "channel", 101);
    expect(state.memories.map((memory) => memory.slot).sort()).toEqual(["a", "b"]);
  });
});
