import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  RevisionConflictError,
  type CampaignKey,
  type CampaignUnitOfWork,
  type StoredCampaign,
} from "../../../src/application/campaign/ports/campaign-store.js";
import type { CampaignRecord } from "../../../src/application/campaign/ports/campaign-record.js";
import { emptyChannels } from "../../../src/application/campaign/ports/campaign-record.js";
import { openLobby } from "../../../src/domain/campaign/lobby/lobby.js";
import type { RollResult } from "../../../src/domain/campaign/dice/roll-spec.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { SqliteCampaignStore } from "../../../src/infrastructure/persistence/campaign/sqlite-campaign-store.js";
import { newCampaign, ruleset } from "../../domain/campaign/campaign-fixtures.js";

const key: CampaignKey = { guildId: "g-1", campaignId: "camp-1" };
const other: CampaignKey = { guildId: "g-2", campaignId: "camp-1" };

function campaign(): StoredCampaign {
  return {
    state: newCampaign(),
    revision: 0,
    ruleset: { rulesetId: ruleset().content.rulesetId, rulesetVersion: ruleset().content.version, houseRules: {} },
    adventure: { adventureId: "moonlit-ruins", version: "1" },
  };
}

function record(campaignKey: CampaignKey = key, lifecycle: CampaignRecord["lifecycle"] = "lobby"): CampaignRecord {
  const lobby = openLobby(1, 4);
  if (!lobby.ok) throw new Error("fixture");
  return {
    key: campaignKey,
    name: "Moonlit Ruins",
    organizerId: "u-organizer",
    language: "en",
    lifecycle,
    adventure: { adventureId: "moonlit-ruins", version: "1" },
    pacingPreset: "live",
    pacing: { roundSeconds: 300, rollSeconds: 120, turnSeconds: 180, awayAfterMisses: 2 },
    houseRules: {},
    lobby: lobby.lobby,
    channels: emptyChannels,
    pendingResources: [],
    cards: {},
    createdAt: 1,
    startedAt: null,
  };
}

const roll: RollResult = {
  kind: "dice",
  roll: { expression: { terms: [{ count: 1, sides: 6 }], modifier: 0 }, terms: [{ sides: 6, values: [4] }], modifier: 0, total: 4 },
};

const directories: string[] = [];
const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fileDatabase(): { path: string; open: () => Database.Database } {
  const directory = mkdtempSync(join(tmpdir(), "campaign-store-"));
  directories.push(directory);
  const path = join(directory, "campaign.sqlite");
  return {
    path,
    open: (): Database.Database => {
      const database = new Database(path);
      databases.push(database);
      return database;
    },
  };
}

const stores: readonly { name: string; create: () => CampaignUnitOfWork }[] = [
  { name: "in-memory", create: () => new InMemoryCampaignStore() },
  {
    name: "sqlite",
    create: (): SqliteCampaignStore => {
      const database = new Database(":memory:");
      databases.push(database);
      return new SqliteCampaignStore(database);
    },
  },
];

// One behavior contract, run against every store, so the in-memory store the
// tests use stays a faithful stand-in for the durable one.
describe.each(stores)("campaign store contract: $name", ({ create }) => {
  it("creates, loads, and saves with a compare-and-set revision", async () => {
    const store = create();
    await store.transaction((tx) => tx.createCampaign(key, campaign()));
    await expect(store.transaction((tx) => tx.createCampaign(key, campaign()))).rejects.toThrow("already exists");

    const next = { ...newCampaign(), lastRoundNumber: 3 };
    expect(await store.transaction((tx) => tx.saveCampaign(key, next, 0))).toBe(1);
    await expect(store.transaction((tx) => tx.saveCampaign(key, next, 0))).rejects.toBeInstanceOf(RevisionConflictError);
    const loaded = await store.transaction((tx) => tx.loadCampaign(key));
    expect(loaded).toMatchObject({ revision: 1, state: { lastRoundNumber: 3 }, adventure: { adventureId: "moonlit-ruins" } });
    expect(await store.transaction((tx) => tx.loadCampaign(other))).toBeUndefined();
  });

  it("keeps campaign records with their own compare-and-set revision", async () => {
    const store = create();
    await store.transaction((tx) => tx.createRecord(record()));
    await expect(store.transaction((tx) => tx.createRecord(record()))).rejects.toThrow("already exists");
    expect(await store.transaction((tx) => tx.loadRecord(key))).toMatchObject({ revision: 0, record: { name: "Moonlit Ruins", lifecycle: "lobby" } });
    expect(await store.transaction((tx) => tx.loadRecord(other))).toBeUndefined();

    const started = { ...record(), lifecycle: "active" as const, startedAt: 9 };
    expect(await store.transaction((tx) => tx.saveRecord(started, 0))).toBe(1);
    await expect(store.transaction((tx) => tx.saveRecord(started, 0))).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await store.transaction((tx) => tx.loadRecord(key))).toMatchObject({ revision: 1, record: { lifecycle: "active", startedAt: 9 } });
  });

  it("lists one guild's records in creation order, optionally by lifecycle", async () => {
    const store = create();
    const second: CampaignKey = { guildId: "g-1", campaignId: "camp-2" };
    await store.transaction(async (tx) => {
      await tx.createRecord(record(key, "active"));
      await tx.createRecord(record(second, "lobby"));
      await tx.createRecord(record(other, "lobby"));
    });
    expect((await store.transaction((tx) => tx.listRecords("g-1"))).map((stored) => stored.record.key.campaignId)).toEqual(["camp-1", "camp-2"]);
    expect((await store.transaction((tx) => tx.listRecords("g-1", ["lobby"]))).map((stored) => stored.record.key.campaignId)).toEqual(["camp-2"]);
    expect(await store.transaction((tx) => tx.listRecords("g-none"))).toEqual([]);
  });

  it("finds records by lifecycle across servers", async () => {
    const store = create();
    await store.transaction(async (tx) => {
      await tx.createRecord(record(key, "active"));
      await tx.createRecord(record(other, "active"));
      await tx.createRecord(record({ guildId: "g-3", campaignId: "camp-9" }, "archived"));
    });
    expect((await store.transaction((tx) => tx.listRecordsByLifecycle(["active"]))).map((stored) => stored.record.key.guildId)).toEqual(["g-1", "g-2"]);
    expect(await store.transaction((tx) => tx.listRecordsByLifecycle(["paused"]))).toEqual([]);
  });

  it("keeps one settings row per server, replacing it on save", async () => {
    const store = create();
    expect(await store.transaction((tx) => tx.loadGuildSettings("g-1"))).toBeUndefined();
    await store.transaction(async (tx) => {
      await tx.saveGuildSettings({ guildId: "g-1", categoryId: "cat-1", hubChannelId: null, hubCard: null });
      await tx.saveGuildSettings({ guildId: "g-1", categoryId: "cat-1", hubChannelId: "hub-1", hubCard: null });
      await tx.saveGuildSettings({ guildId: "g-2", categoryId: null, hubChannelId: "hub-2", hubCard: null });
    });
    expect(await store.transaction((tx) => tx.loadGuildSettings("g-1"))).toEqual({ guildId: "g-1", categoryId: "cat-1", hubChannelId: "hub-1", hubCard: null });
    expect((await store.transaction((tx) => tx.loadGuildSettings("g-2")))?.hubChannelId).toBe("hub-2");
  });

  it("rolls a record back with the rest of a failed transaction", async () => {
    const store = create();
    await expect(
      store.transaction(async (tx) => {
        await tx.createRecord(record());
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.transaction((tx) => tx.loadRecord(key))).toBeUndefined();
  });

  it("numbers events per campaign and keeps them in order", async () => {
    const store = create();
    const envelope = { campaignId: "camp-1", causationId: "c", commandKind: "openRound", actor: { kind: "system" }, rulesRevision: "r", recordedAt: 5 } as const;
    await store.transaction(async (tx) => {
      await tx.appendEvents(key, [{ ...envelope, event: { kind: "waitingForPlayers" } }]);
      await tx.appendEvents(key, [
        { ...envelope, event: { kind: "memberReturned", userId: "u" } },
        { ...envelope, event: { kind: "waitingForPlayers" } },
      ]);
      await tx.appendEvents(other, [{ ...envelope, event: { kind: "waitingForPlayers" } }]);
    });
    const events = await store.transaction((tx) => tx.readEvents(key));
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[1]?.event).toEqual({ kind: "memberReturned", userId: "u" });
    expect(await store.transaction((tx) => tx.readEvents(other))).toHaveLength(1);
  });

  it("remembers processed commands per campaign", async () => {
    const store = create();
    await store.transaction((tx) => tx.recordProcessedCommand(key, "cmd-1", { kind: "accepted", revision: 1, eventCount: 2 }));
    expect(await store.transaction((tx) => tx.findProcessedCommand(key, "cmd-1"))).toEqual({ kind: "accepted", revision: 1, eventCount: 2 });
    expect(await store.transaction((tx) => tx.findProcessedCommand(other, "cmd-1"))).toBeUndefined();
  });

  it("queues work once, retries with a bound, and skips finished items", async () => {
    const store = create();
    const request = { kind: "narrate", roundNumber: 1 } as const;
    await store.transaction(async (tx) => {
      await tx.enqueue(key, "job-1", request, 10);
      await tx.enqueue(key, "job-1", { kind: "narrate", roundNumber: 99 }, 20);
      await tx.enqueue(key, "job-2", { kind: "plan", roundNumber: 1 }, 30);
    });
    const pending = await store.transaction((tx) => tx.pendingOutbox("narrate"));
    expect(pending).toEqual([{ id: "job-1", key, request, status: "pending", attempts: 0, createdAt: 10, lastError: null }]);

    await store.transaction((tx) => tx.failOutboxAttempt("job-1", "boom", 2));
    expect((await store.transaction((tx) => tx.pendingOutbox("narrate")))[0]).toMatchObject({ attempts: 1, lastError: "boom" });
    await store.transaction((tx) => tx.failOutboxAttempt("job-1", "boom again", 2));
    expect(await store.transaction((tx) => tx.pendingOutbox("narrate"))).toEqual([]);

    await store.transaction((tx) => tx.completeOutbox("job-2"));
    expect(await store.transaction((tx) => tx.pendingOutbox("plan"))).toEqual([]);
  });

  it("returns only due, pending timers, and lets a reschedule replace one", async () => {
    const store = create();
    const timer = (timerId: string, dueAt: number): { kind: "roundWindow"; timerId: string; dueAt: number; roundNumber: number } => ({
      kind: "roundWindow",
      timerId,
      dueAt,
      roundNumber: 1,
    });
    await store.transaction(async (tx) => {
      await tx.scheduleTimer(key, timer("late", 300));
      await tx.scheduleTimer(key, timer("early", 100));
      await tx.scheduleTimer(key, timer("cancelled", 50));
      await tx.cancelTimer(key, "cancelled");
    });
    expect((await store.transaction((tx) => tx.dueTimers(200))).map((record) => record.timer.timerId)).toEqual(["early"]);
    await store.transaction(async (tx) => {
      await tx.markTimerFired(key, "early");
      await tx.scheduleTimer(key, timer("late", 150));
    });
    const due = await store.transaction((tx) => tx.dueTimers(200));
    expect(due).toEqual([{ key, timer: timer("late", 150), status: "pending" }]);
  });

  it("keeps the first saved roll for an ID", async () => {
    const store = create();
    const first = await store.transaction((tx) => tx.saveRoll({ key, rollId: "r1", result: roll, rolledAt: 1 }));
    const again = await store.transaction((tx) =>
      tx.saveRoll({ key, rollId: "r1", result: { ...roll, roll: { ...roll.roll, total: 6 } }, rolledAt: 2 }),
    );
    expect(again).toEqual(first);
    expect((await store.transaction((tx) => tx.findRoll(key, "r1")))?.result).toEqual(roll);
    expect(await store.transaction((tx) => tx.findRoll(other, "r1"))).toBeUndefined();
  });

  it("rolls back everything when a transaction fails part-way", async () => {
    const store = create();
    await store.transaction((tx) => tx.createCampaign(key, campaign()));
    await expect(
      store.transaction(async (tx) => {
        await tx.saveCampaign(key, { ...newCampaign(), lastRoundNumber: 9 }, 0);
        await tx.saveRoll({ key, rollId: "r-lost", result: roll, rolledAt: 1 });
        throw new Error("crash");
      }),
    ).rejects.toThrow("crash");
    expect((await store.transaction((tx) => tx.loadCampaign(key)))?.revision).toBe(0);
    expect(await store.transaction((tx) => tx.findRoll(key, "r-lost"))).toBeUndefined();
  });
});

describe("sqlite campaign store on disk", () => {
  it("keeps a saved roll, its outbox item, and a timer across a restart", async () => {
    const file = fileDatabase();
    const first = new SqliteCampaignStore(file.open());
    await first.transaction(async (tx) => {
      await tx.createCampaign(key, campaign());
      await tx.saveRoll({ key, rollId: "r1", result: roll, rolledAt: 1 });
      await tx.enqueue(key, "job-1", { kind: "roll", rollId: "r1", spec: { kind: "dice", expression: roll.roll.expression, critical: false } }, 1);
      await tx.scheduleTimer(key, { kind: "roundWindow", timerId: "round:1", dueAt: 500, roundNumber: 1 });
    });
    databases.at(-1)?.close();

    const second = new SqliteCampaignStore(file.open());
    expect((await second.transaction((tx) => tx.findRoll(key, "r1")))?.result).toEqual(roll);
    expect(await second.transaction((tx) => tx.pendingOutbox("roll"))).toHaveLength(1);
    expect((await second.transaction((tx) => tx.dueTimers(1_000))).map((record) => record.timer.timerId)).toEqual(["round:1"]);
  });

  it("upgrades a version 1 database in place without losing campaigns", async () => {
    const file = fileDatabase();
    const raw = file.open();
    const first = new SqliteCampaignStore(raw);
    await first.transaction((tx) => tx.createCampaign(key, campaign()));
    raw.prepare("DROP TABLE campaign_records").run();
    raw.prepare("UPDATE campaign_meta SET version = 1").run();
    const upgraded = new SqliteCampaignStore(raw);
    expect(await upgraded.transaction((tx) => tx.loadCampaign(key))).toBeDefined();
    await upgraded.transaction((tx) => tx.createRecord(record()));
    expect(raw.prepare("SELECT version FROM campaign_meta").get()).toEqual({ version: 2 });
  });

  it("refuses a database written by a different schema version", () => {
    const file = fileDatabase();
    const raw = file.open();
    new SqliteCampaignStore(raw);
    raw.prepare("UPDATE campaign_meta SET version = 99").run();
    expect(() => new SqliteCampaignStore(raw)).toThrow("not supported");
  });
});
