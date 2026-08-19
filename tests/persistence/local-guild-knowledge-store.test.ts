import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalGuildKnowledgeStore } from "../../src/infrastructure/persistence/local-guild-knowledge-store.js";

describe("LocalGuildKnowledgeStore", () => {
  it("confirms safe self-reported public knowledge", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guild-knowledge-"));
    const store = new LocalGuildKnowledgeStore(directory);
    await store.initialize();
    await store.propose({
      guildId: "guild", assertedByUserId: "user", now: 100,
      candidates: [{
        subjectType: "member", subjectId: "user", topic: "event_responsibility",
        slot: "raid.friday", statement: "organizes Friday raids", embedding: null,
      }],
    });
    expect(await store.loadConfirmed("guild")).toMatchObject([{
      subjectType: "member", subjectId: "user", statement: "organizes Friday raids", source: "self_report",
    }]);
  });

  it("keeps third-party claims pending and out of normal context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guild-knowledge-"));
    const store = new LocalGuildKnowledgeStore(directory);
    await store.initialize();
    await store.propose({
      guildId: "guild", assertedByUserId: "alice", now: 100,
      candidates: [{
        subjectType: "member", subjectId: "dave", topic: "event_responsibility",
        slot: "raid.friday", statement: "organizes Friday raids", embedding: null,
      }],
    });
    expect(await store.loadConfirmed("guild")).toEqual([]);
    const document = JSON.parse(readFileSync(join(directory, "chat", "guild", "guild-knowledge.json"), "utf8")) as {
      records: Array<{ status: string; assertedByUserIds: string[] }>;
    };
    expect(document.records).toMatchObject([{ status: "candidate", assertedByUserIds: ["alice"] }]);
  });

  it("promotes a third-party candidate when its subject later self-confirms", async () => {
    const directory = mkdtempSync(join(tmpdir(), "guild-knowledge-"));
    const store = new LocalGuildKnowledgeStore(directory);
    await store.initialize();
    const candidate = {
      subjectType: "member" as const, subjectId: "dave", topic: "event_responsibility",
      slot: "raid.friday", statement: "organizes Friday raids", embedding: null,
    };
    await store.propose({ guildId: "guild", assertedByUserId: "alice", candidates: [candidate], now: 100 });
    await store.propose({ guildId: "guild", assertedByUserId: "dave", candidates: [candidate], now: 101 });
    expect(await store.loadConfirmed("guild")).toHaveLength(1);
  });
});
