import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { runHarness } from "../../../src/application/campaign/harness/campaign-harness.js";
import { defaultHarnessPlayers } from "../../../src/application/campaign/harness/harness-personas.js";
import { RuleBasedPlanner, TemplateNarrator } from "../../../src/application/campaign/harness/rule-based-dm.js";
import { emptyChannels } from "../../../src/application/campaign/ports/campaign-record.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { RulesetCatalog } from "../../../src/application/campaign/rules/ruleset-catalog.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { openLobby } from "../../../src/domain/campaign/lobby/lobby.js";
import { loadStarterAdventure } from "../../../src/infrastructure/campaign/starter-adventures.js";
import type { DatabaseConnection } from "../../../src/infrastructure/database/database.js";
import { importSqliteCampaigns } from "../../../src/infrastructure/persistence/campaign/import-sqlite-campaigns.js";
import { PostgresCampaignStore } from "../../../src/infrastructure/persistence/campaign/postgres-campaign-store.js";
import { SqliteCampaignStore } from "../../../src/infrastructure/persistence/campaign/sqlite-campaign-store.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";
import { postgresTestDatabase } from "./postgres-test-database.js";

// A game played on SQLite, then carried to PostgreSQL by the import script.
const database = await postgresTestDatabase("campaign_import");
const content = ruleset().content;
const key: CampaignKey = { guildId: "harness", campaignId: "harness" };

const connections: DatabaseConnection[] = [];
afterAll(async () => {
  for (const connection of connections) await connection.close();
});

if (database === null) {
  describe.skip("importing SQLite campaigns into PostgreSQL", () => {
    it("needs CAMPAIGN_TEST_DATABASE_URL", () => undefined);
  });
} else {
  beforeEach(async () => {
    const connection = await database.connect();
    try {
      await database.clear(connection);
    } finally {
      await connection.close();
    }
  });

  describe("importing SQLite campaigns into PostgreSQL", () => {
    it("copies a played game, its record, its library and its adventures, keeps their order, and does nothing the second time", async () => {
      const sqlite = new Database(":memory:");
      const source = new SqliteCampaignStore(sqlite);
      const starter = loadStarterAdventure();
      const played = await runHarness({
        adventure: starter.en,
        players: defaultHarnessPlayers,
        dm: () => ({ planner: new RuleBasedPlanner(), narrator: new TemplateNarrator() }),
        random: new SeededRandomSource(3),
        rulesets: new RulesetCatalog([content]),
        rulesetPin: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
        glossary: enSrd51Glossary,
        unitOfWork: source,
        rounds: 6,
        measure: () => 0,
      });
      expect(played.events.length).toBeGreaterThan(20);
      const lobby = openLobby(1, 3);
      if (!lobby.ok) throw new Error("lobby");
      await source.transaction(async (tx) => {
        await tx.createRecord({
          key,
          name: "Moonlit Ruins",
          organizerId: "u-org",
          language: "en",
          lifecycle: "active",
          adventure: { adventureId: "moonlit-ruins", version: "1" },
          pacingPreset: "live",
          pacing: { roundSeconds: 300, rollSeconds: 120, turnSeconds: 180, awayAfterMisses: 2 },
          houseRules: {},
          lobby: lobby.lobby,
          channels: emptyChannels,
          pendingResources: [],
          cards: {},
          createdAt: 1,
          startedAt: 2,
        });
        await tx.saveGuildSettings({ guildId: "harness", categoryId: "cat", hubChannelId: "hub", hubCard: null });
        await tx.saveLibraryCharacter({ id: "lc-1", ownerUserId: "u-1", name: "Aldric", className: "fighter", createdAt: 1 });
        await tx.enqueue(key, "job-1", { kind: "narrate", roundNumber: 9 }, 5);
        await tx.saveAdventure({ key: "en:g1-x:1", id: "g1-x", guildId: "harness", version: "1", uploaderUserId: "u-1", status: "approved", source: "upload", language: "en", title: "X", yaml: "id: g1-x", warnings: [], createdAt: 3 });
      });

      const connection = await database.connect();
      connections.push(connection);
      const counts = await importSqliteCampaigns(sqlite, connection.database);
      expect(counts).toMatchObject({ campaigns: 1, records: 1, guildSettings: 1, libraryCharacters: 1, adventures: 1 });
      expect(counts.outbox).toBeGreaterThan(1);
      expect(counts.events).toBe(played.events.length);

      const target = new PostgresCampaignStore(() => Promise.resolve(connection.database));
      const read = (store: SqliteCampaignStore | PostgresCampaignStore): Promise<unknown> =>
        store.transaction(async (tx) => ({
          campaign: await tx.loadCampaign(key),
          events: await tx.readEvents(key),
          record: await tx.loadRecord(key),
          settings: await tx.listGuildSettings(),
          character: await tx.loadLibraryCharacter("lc-1"),
          outbox: [await tx.pendingOutbox("narrate"), await tx.pendingOutbox("deliver"), await tx.pendingOutbox("roll")],
          adventure: await tx.loadAdventure("en:g1-x:1"),
        }));
      // Everything reads back exactly as it was, including the party's order.
      expect(await read(target)).toEqual(await read(source));

      // A second run finds it all there.
      const again = await importSqliteCampaigns(sqlite, connection.database);
      expect(Object.values(again).every((count) => count === 0)).toBe(true);
      sqlite.close();
    });

    it("copies nothing from an empty or older database, and does not fail", async () => {
      const sqlite = new Database(":memory:");
      const connection = await database.connect();
      connections.push(connection);
      const counts = await importSqliteCampaigns(sqlite, connection.database);
      expect(Object.values(counts).every((count) => count === 0)).toBe(true);
      sqlite.close();
    });
  });
}
