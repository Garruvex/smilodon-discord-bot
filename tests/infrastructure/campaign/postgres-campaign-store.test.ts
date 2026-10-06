import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { CampaignCommandBus } from "../../../src/application/campaign/campaign-command-bus.js";
import { runHarness, type HarnessOptions } from "../../../src/application/campaign/harness/campaign-harness.js";
import { defaultHarnessPlayers } from "../../../src/application/campaign/harness/harness-personas.js";
import { renderReport, summarizeRun } from "../../../src/application/campaign/harness/harness-report.js";
import { RuleBasedPlanner, TemplateNarrator } from "../../../src/application/campaign/harness/rule-based-dm.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { RulesetCatalog } from "../../../src/application/campaign/rules/ruleset-catalog.js";
import { ManualClock } from "../../../src/application/campaign/time/manual-clock.js";
import { RollWorker } from "../../../src/application/campaign/workers/roll-worker.js";
import { TimerWorker } from "../../../src/application/campaign/workers/timer-worker.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import type { DatabaseConnection } from "../../../src/infrastructure/database/database.js";
import { loadStarterAdventure } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { PostgresCampaignStore } from "../../../src/infrastructure/persistence/campaign/postgres-campaign-store.js";
import { alex, jamie, newCampaign, ruleset, system } from "../../domain/campaign/campaign-fixtures.js";
import { postgresTestDatabase } from "./postgres-test-database.js";

// Milestone 6: the acceptance scenarios that need a real database to mean
// anything, run against PostgreSQL. Skipped unless CAMPAIGN_TEST_DATABASE_URL
// is set (see postgres-test-database.ts).
const database = await postgresTestDatabase("campaign_recovery");

const key: CampaignKey = { guildId: "g-1", campaignId: "camp-1" };
const content = ruleset().content;
const rulesets = new RulesetCatalog([content]);
const pin = { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} };

const connections: DatabaseConnection[] = [];
afterAll(async () => {
  for (const connection of connections) await connection.close();
});

// A new process: its own connection to the same database.
async function restart(): Promise<PostgresCampaignStore> {
  const connection = await database?.connect();
  if (connection === undefined) throw new Error("no database");
  connections.push(connection);
  return new PostgresCampaignStore(() => Promise.resolve(connection.database));
}

async function seed(store: PostgresCampaignStore, clock: ManualClock): Promise<CampaignCommandBus> {
  await store.transaction((tx) => tx.createCampaign(key, { state: newCampaign(), revision: 0, ruleset: pin, adventure: { adventureId: "moonlit-ruins", version: "1" } }));
  return new CampaignCommandBus({ unitOfWork: store, rulesets, clock });
}

const miraSneaks = {
  roundNumber: 1,
  actions: [{ characterId: "c-mira", resolution: { kind: "check" as const, test: { kind: "skill" as const, skill: "stealth" as const }, dcTier: "medium" as const, rollModeReasons: [] } }],
};

if (database === null) {
  describe.skip("PostgreSQL campaign recovery", () => {
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

  describe("restarting mid-play on PostgreSQL", () => {
    it("resumes a crash after a saved roll from the same dice, never rolling again", async () => {
      const clock = new ManualClock(0);
      const first = await restart();
      const bus = await seed(first, clock);
      await bus.execute(key, { kind: "openRound" }, { commandId: "1", actor: system });
      await bus.execute(key, { kind: "submitAction", characterId: "c-mira", text: "I sneak." }, { commandId: "2", actor: alex });
      await bus.execute(key, { kind: "pass", characterId: "c-borin" }, { commandId: "3", actor: jamie });
      await bus.execute(key, { kind: "applyRoundPlan", proposal: miraSneaks }, { commandId: "4", actor: system });
      await bus.execute(key, { kind: "requestRoll", checkId: "r1:c-mira" }, { commandId: "5", actor: alex });

      // The roll is saved, then the process dies before the engine sees it.
      const crashingBus = { execute: (): Promise<never> => Promise.reject(new Error("process died")) } as unknown as CampaignCommandBus;
      expect((await new RollWorker(first, crashingBus, new SeededRandomSource(1), clock).runOnce()).failed).toHaveLength(1);
      const saved = await first.transaction((tx) => tx.findRoll(key, "r1:c-mira:roll"));
      expect(saved?.result.kind).toBe("d20Test");

      // A new process, different dice: the saved ones are used.
      const second = await restart();
      const resumed = await new RollWorker(second, new CampaignCommandBus({ unitOfWork: second, rulesets, clock }), new SeededRandomSource(999), clock).runOnce();
      expect(resumed).toEqual({ processed: 1, failed: [] });
      const check = (await second.transaction((tx) => tx.loadCampaign(key)))?.state.checks["r1:c-mira"];
      expect(check?.status).toBe("resolved");
      expect(check?.result?.roll).toEqual(saved?.result.kind === "d20Test" ? saved.result.roll : undefined);
      expect(await second.transaction((tx) => tx.pendingOutbox("roll"))).toEqual([]);
    });

    it("keeps a round timer across a restart and fires it once when it comes due", async () => {
      const clock = new ManualClock(0);
      await seed(await restart(), clock).then((bus) => bus.execute(key, { kind: "openRound" }, { commandId: "1", actor: system }));
      const store = await restart();
      clock.advance(301_000);
      const timers = new TimerWorker(store, new CampaignCommandBus({ unitOfWork: store, rulesets, clock }), clock);
      expect(await timers.runOnce()).toEqual({ processed: 1, failed: [] });
      const events = (await store.transaction((tx) => tx.readEvents(key))).map((envelope) => envelope.event);
      expect(events).toContainEqual({ kind: "roundClosed", roundNumber: 1, reason: "timer", missed: ["c-mira", "c-borin"] });
      expect(await timers.runOnce()).toEqual({ processed: 0, failed: [] });
    });

    it("answers a repeated command after a restart with the original outcome and no new events", async () => {
      const clock = new ManualClock(0);
      const first = await restart();
      const outcome = await (await seed(first, clock)).execute(key, { kind: "openRound" }, { commandId: "open-1", actor: system });
      const count = (await first.transaction((tx) => tx.readEvents(key))).length;
      const store = await restart();
      const again = await new CampaignCommandBus({ unitOfWork: store, rulesets, clock }).execute(key, { kind: "openRound" }, { commandId: "open-1", actor: system });
      expect(again).toEqual(outcome);
      expect(await store.transaction((tx) => tx.readEvents(key))).toHaveLength(count);
    });

    it("shows another connection nothing of a transaction that fails after writing", async () => {
      await seed(await restart(), new ManualClock(0));
      const failing = await restart();
      const observer = await restart();
      let seenByObserverDuringTransaction: unknown = "unchecked";
      const attempt = failing.transaction(async (tx) => {
        await tx.saveCampaign(key, { ...newCampaign(), lastRoundNumber: 7 }, 0);
        await tx.saveRoll({ key, rollId: "r-torn", result: { kind: "d20Test", roll: { d20: { mode: "normal", values: [10], natural: 10, modifier: 0, total: 10 }, bonusDice: [], total: 10 } }, rolledAt: 1 });
        // Uncommitted work is invisible to everyone else, and after the failure it never existed.
        seenByObserverDuringTransaction = (await observer.transaction((other) => other.findRoll(key, "r-torn"))) ?? null;
        throw new Error("the process is gone");
      });
      await expect(attempt).rejects.toThrow("the process is gone");
      expect(seenByObserverDuringTransaction).toBeNull();
      const reopened = await restart();
      expect(await reopened.transaction((tx) => tx.loadCampaign(key))).toMatchObject({ revision: 0, state: { lastRoundNumber: 0 } });
      expect(await reopened.transaction((tx) => tx.findRoll(key, "r-torn"))).toBeUndefined();
    });
  });

  describe("two writers", () => {
    it("lets exactly one of two racing saves through, on separate connections, and refuses the other as stale", async () => {
      const seeded = await restart();
      await seed(seeded, new ManualClock(0));
      const a = await restart();
      const b = await restart();
      const save = (store: PostgresCampaignStore, round: number): Promise<"saved" | "stale"> =>
        store
          .transaction((tx) => tx.saveCampaign(key, { ...newCampaign(), lastRoundNumber: round }, 0))
          .then(() => "saved" as const)
          .catch((error: unknown) => (error instanceof Error && error.name === "RevisionConflictError" ? ("stale" as const) : Promise.reject(error instanceof Error ? error : new Error(String(error)))));
      const results = await Promise.all([save(a, 1), save(b, 2)]);
      expect(results.filter((result) => result === "saved")).toHaveLength(1);
      expect(results.filter((result) => result === "stale")).toHaveLength(1);
      expect((await seeded.transaction((tx) => tx.loadCampaign(key)))?.revision).toBe(1);
    });

    it("gives events one unbroken numbering", async () => {
      const store = await restart();
      await seed(store, new ManualClock(0));
      const envelope = { campaignId: key.campaignId, causationId: "c", commandKind: "openRound", actor: { kind: "system" }, rulesRevision: "srd-5.1@1", recordedAt: 1, event: { kind: "tableReady" } } as const;
      await store.transaction((tx) => tx.appendEvents(key, [envelope, envelope]));
      await store.transaction((tx) => tx.appendEvents(key, [envelope]));
      expect((await store.transaction((tx) => tx.readEvents(key))).map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    });
  });

  describe("the durable store matches the in-memory one", () => {
    const starter = loadStarterAdventure();
    const options = (unitOfWork: HarnessOptions["unitOfWork"]): HarnessOptions => ({
      adventure: starter.en,
      players: defaultHarnessPlayers,
      dm: () => ({ planner: new RuleBasedPlanner(), narrator: new TemplateNarrator() }),
      random: new SeededRandomSource(3),
      rulesets,
      rulesetPin: pin,
      glossary: enSrd51Glossary,
      unitOfWork,
      rounds: 6,
      measure: () => 0,
    });

    it("plays the same six-round game, chapel fight included, to the same transcript", async () => {
      const memory = await runHarness(options(new InMemoryCampaignStore()));
      const durable = await runHarness(options(await restart()));
      expect(renderReport(durable, summarizeRun(durable))).toBe(renderReport(memory, summarizeRun(memory)));
      expect(durable.events).toEqual(memory.events);
      expect(durable.finalState).toEqual(memory.finalState);
    });
  });

  it("uses no table outside the campaign ones for its own data", async () => {
    const connection = await database.connect();
    connections.push(connection);
    const rows = await connection.database.execute(sql`select table_name from information_schema.tables where table_schema = ${database.schemaName} order by table_name`);
    expect((rows as unknown as { table_name: string }[]).map((row) => row.table_name).every((name) => name.startsWith("campaign_"))).toBe(true);
  });
}
