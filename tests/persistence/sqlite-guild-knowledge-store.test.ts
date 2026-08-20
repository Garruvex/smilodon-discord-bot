import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteGuildKnowledgeStore } from "../../src/infrastructure/persistence/sqlite-guild-knowledge-store.js";

function store(): SqliteGuildKnowledgeStore {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-guild-knowledge-"));
  const connection = createSqliteDatabaseConnection(directory);
  return new SqliteGuildKnowledgeStore(connection.database);
}

describe("SqliteGuildKnowledgeStore", () => {
  it("confirms safe self-reported public knowledge", async () => {
    const knowledgeStore = store();
    await knowledgeStore.propose({
      guildId: "guild", assertedByUserId: "user", now: 100,
      candidates: [{
        subjectType: "member", subjectId: "user", topic: "event_responsibility",
        slot: "raid.friday", statement: "organizes Friday raids", embedding: null,
        channelId: null, channelScoped: false,
      }],
    });
    expect(await knowledgeStore.loadConfirmed("guild", "channel")).toMatchObject([{
      subjectType: "member", subjectId: "user", statement: "organizes Friday raids", source: "self_report",
    }]);
  });

  it("keeps third-party claims pending and out of normal context", async () => {
    const knowledgeStore = store();
    await knowledgeStore.propose({
      guildId: "guild", assertedByUserId: "alice", now: 100,
      candidates: [{
        subjectType: "member", subjectId: "dave", topic: "event_responsibility",
        slot: "raid.friday", statement: "organizes Friday raids", embedding: null,
        channelId: null, channelScoped: false,
      }],
    });
    expect(await knowledgeStore.loadConfirmed("guild", "channel")).toEqual([]);
  });

  it("promotes a third-party candidate when its subject later self-confirms", async () => {
    const knowledgeStore = store();
    const candidate = {
      subjectType: "member" as const, subjectId: "dave", topic: "event_responsibility",
      slot: "raid.friday", statement: "organizes Friday raids", embedding: null,
      channelId: null, channelScoped: false,
    };
    await knowledgeStore.propose({ guildId: "guild", assertedByUserId: "alice", candidates: [candidate], now: 100 });
    await knowledgeStore.propose({ guildId: "guild", assertedByUserId: "dave", candidates: [candidate], now: 101 });
    expect(await knowledgeStore.loadConfirmed("guild", "channel")).toHaveLength(1);
  });

  it("lands a consolidation candidate (null assertedByUserId) as a pending candidate, not self-confirmed", async () => {
    const knowledgeStore = store();
    await knowledgeStore.propose({
      guildId: "guild", assertedByUserId: null, now: 100,
      candidates: [{
        subjectType: "guild", subjectId: "guild", topic: "scene_summary",
        slot: "scene.discovery", statement: "the party found a hidden door", embedding: null,
        channelId: "channel", channelScoped: true,
      }],
    });
    expect(await knowledgeStore.loadConfirmed("guild", "channel")).toEqual([]);
  });

  it("scopes a channel-tagged fact to its channel while a guild-wide fact stays visible everywhere", async () => {
    const knowledgeStore = store();
    await knowledgeStore.propose({
      guildId: "guild", assertedByUserId: "user", now: 100,
      candidates: [{
        subjectType: "member", subjectId: "user", topic: "event_responsibility",
        slot: "scene.location", statement: "the party is in the tavern", embedding: null,
        channelId: "channel-a", channelScoped: true,
      }],
    });
    await knowledgeStore.propose({
      guildId: "guild", assertedByUserId: "user", now: 100,
      candidates: [{
        subjectType: "member", subjectId: "user", topic: "event_responsibility",
        slot: "raid.friday", statement: "organizes Friday raids", embedding: null,
        channelId: null, channelScoped: false,
      }],
    });

    const channelA = await knowledgeStore.loadConfirmed("guild", "channel-a");
    const channelB = await knowledgeStore.loadConfirmed("guild", "channel-b");
    expect(channelA.map((record) => record.statement).sort()).toEqual([
      "organizes Friday raids", "the party is in the tavern",
    ]);
    expect(channelB.map((record) => record.statement)).toEqual(["organizes Friday raids"]);
  });

  it("lets a channel-scoped fact and a guild-wide fact coexist under the same subject/topic/slot", async () => {
    const knowledgeStore = store();
    await knowledgeStore.propose({
      guildId: "guild", assertedByUserId: "user", now: 100,
      candidates: [{
        subjectType: "member", subjectId: "user", topic: "event_responsibility",
        slot: "raid.friday", statement: "guild-wide claim", embedding: null,
        channelId: null, channelScoped: false,
      }],
    });
    await knowledgeStore.propose({
      guildId: "guild", assertedByUserId: "user", now: 100,
      candidates: [{
        subjectType: "member", subjectId: "user", topic: "event_responsibility",
        slot: "raid.friday", statement: "channel-scoped claim", embedding: null,
        channelId: "channel-a", channelScoped: true,
      }],
    });

    const channelA = await knowledgeStore.loadConfirmed("guild", "channel-a");
    expect(channelA.map((record) => record.statement).sort()).toEqual(["channel-scoped claim", "guild-wide claim"]);
  });

  it("survives two concurrent proposals for different subjects without losing either (the JSON backend's race)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sqlite-guild-knowledge-"));
    const connection = createSqliteDatabaseConnection(directory);
    const knowledgeStore = new SqliteGuildKnowledgeStore(connection.database);
    await Promise.all([
      knowledgeStore.propose({
        guildId: "guild", assertedByUserId: "alice", now: 100,
        candidates: [{
          subjectType: "member", subjectId: "alice", topic: "event_responsibility",
          slot: "raid.friday", statement: "organizes Friday raids", embedding: null,
          channelId: null, channelScoped: false,
        }],
      }),
      knowledgeStore.propose({
        guildId: "guild", assertedByUserId: "bob", now: 100,
        candidates: [{
          subjectType: "member", subjectId: "bob", topic: "event_responsibility",
          slot: "raid.saturday", statement: "organizes Saturday raids", embedding: null,
          channelId: null, channelScoped: false,
        }],
      }),
    ]);
    const confirmed = await knowledgeStore.loadConfirmed("guild", "channel");
    expect(confirmed.map((record) => record.statement).sort()).toEqual([
      "organizes Friday raids", "organizes Saturday raids",
    ]);
  });
});
