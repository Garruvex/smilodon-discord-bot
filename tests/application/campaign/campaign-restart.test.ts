import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

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
import { loadStarterAdventure } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { SqliteCampaignStore } from "../../../src/infrastructure/persistence/campaign/sqlite-campaign-store.js";
import { alex, jamie, newCampaign, ruleset, system } from "../../domain/campaign/campaign-fixtures.js";

const key: CampaignKey = { guildId: "g-1", campaignId: "camp-1" };
const content = ruleset().content;
const rulesets = new RulesetCatalog([content]);
const pin = { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} };

const directories: string[] = [];
const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// A file-backed database that can be closed and reopened, like a restart.
function disk(): { path: string; open: () => SqliteCampaignStore; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "campaign-restart-"));
  directories.push(directory);
  const path = join(directory, "campaign.sqlite");
  return {
    path,
    open: (): SqliteCampaignStore => {
      const database = new Database(path);
      databases.push(database);
      return new SqliteCampaignStore(database);
    },
    close: () => databases.at(-1)?.close(),
  };
}

async function seed(store: SqliteCampaignStore, clock: ManualClock): Promise<CampaignCommandBus> {
  await store.transaction((tx) =>
    tx.createCampaign(key, { state: newCampaign(), revision: 0, ruleset: pin, adventure: { adventureId: "moonlit-ruins", version: "1" } }),
  );
  return new CampaignCommandBus({ unitOfWork: store, rulesets, clock });
}

const miraSneaks = {
  roundNumber: 1,
  actions: [
    {
      characterId: "c-mira",
      resolution: { kind: "check" as const, test: { kind: "skill" as const, skill: "stealth" as const }, dcTier: "medium" as const, rollModeReasons: [] },
    },
  ],
};

describe("restarting mid-play on a file-backed database", () => {
  it("resumes a crash after a saved roll from the same dice, never rolling again", async () => {
    const file = disk();
    const clock = new ManualClock(0);
    const first = file.open();
    const bus = await seed(first, clock);
    await bus.execute(key, { kind: "openRound" }, { commandId: "1", actor: system });
    await bus.execute(key, { kind: "submitAction", characterId: "c-mira", text: "I sneak." }, { commandId: "2", actor: alex });
    await bus.execute(key, { kind: "pass", characterId: "c-borin" }, { commandId: "3", actor: jamie });
    await bus.execute(key, { kind: "applyRoundPlan", proposal: miraSneaks }, { commandId: "4", actor: system });
    await bus.execute(key, { kind: "requestRoll", checkId: "r1:c-mira" }, { commandId: "5", actor: alex });

    // The roll is saved, then the process dies before the engine sees it.
    const crashingBus = { execute: (): Promise<never> => Promise.reject(new Error("process died")) } as unknown as CampaignCommandBus;
    const crashed = await new RollWorker(first, crashingBus, new SeededRandomSource(1), clock).runOnce();
    expect(crashed.failed).toHaveLength(1);
    const saved = await first.transaction((tx) => tx.findRoll(key, "r1:c-mira:roll"));
    expect(saved?.result.kind).toBe("d20Test");
    file.close();

    // After the restart, different dice would give a different number; the saved ones are used.
    const second = file.open();
    const restartedBus = new CampaignCommandBus({ unitOfWork: second, rulesets, clock });
    const resumed = await new RollWorker(second, restartedBus, new SeededRandomSource(999), clock).runOnce();
    expect(resumed).toEqual({ processed: 1, failed: [] });
    const stored = await second.transaction((tx) => tx.loadCampaign(key));
    const check = stored?.state.checks["r1:c-mira"];
    expect(check?.status).toBe("resolved");
    expect(check?.result?.roll).toEqual(saved?.result.kind === "d20Test" ? saved.result.roll : undefined);
    expect(await second.transaction((tx) => tx.pendingOutbox("roll"))).toEqual([]);
  });

  it("keeps a round timer across a restart and fires it once when it comes due", async () => {
    const file = disk();
    const clock = new ManualClock(0);
    const bus = await seed(file.open(), clock);
    await bus.execute(key, { kind: "openRound" }, { commandId: "1", actor: system });
    file.close();

    const store = file.open();
    clock.advance(301_000);
    const timers = new TimerWorker(store, new CampaignCommandBus({ unitOfWork: store, rulesets, clock }), clock);
    expect(await timers.runOnce()).toEqual({ processed: 1, failed: [] });
    const closed = (await store.transaction((tx) => tx.readEvents(key))).map((envelope) => envelope.event);
    expect(closed).toContainEqual({ kind: "roundClosed", roundNumber: 1, reason: "timer", missed: ["c-mira", "c-borin"] });
    expect(await timers.runOnce()).toEqual({ processed: 0, failed: [] });
  });

  it("answers a repeated command after a restart with the original outcome and no new events", async () => {
    const file = disk();
    const clock = new ManualClock(0);
    const first = file.open();
    const bus = await seed(first, clock);
    const outcome = await bus.execute(key, { kind: "openRound" }, { commandId: "open-1", actor: system });
    const count = (await first.transaction((tx) => tx.readEvents(key))).length;
    file.close();

    const store = file.open();
    const again = await new CampaignCommandBus({ unitOfWork: store, rulesets, clock }).execute(
      key,
      { kind: "openRound" },
      { commandId: "open-1", actor: system },
    );
    expect(again).toEqual(outcome);
    expect(await store.transaction((tx) => tx.readEvents(key))).toHaveLength(count);
  });

  it("loses nothing but the open transaction when the process is killed mid-write", async () => {
    const file = disk();
    const store = file.open();
    await seed(store, new ManualClock(0));
    file.close();

    const child = spawnSync(process.execPath, ["--import", "tsx", "tests/fixtures/campaign-store-crash.ts", file.path], { encoding: "utf8" });
    // Windows reports a killed process by exit code rather than by signal.
    expect(child.status === 0).toBe(false);

    const reopened = file.open();
    const stored = await reopened.transaction((tx) => tx.loadCampaign(key));
    expect(stored).toMatchObject({ revision: 0, state: { lastRoundNumber: 0 } });
    expect(await reopened.transaction((tx) => tx.findRoll(key, "r-torn"))).toBeUndefined();
  });
});

describe("the durable store matches the in-memory one", () => {
  const starter = loadStarterAdventure();
  function options(unitOfWork: HarnessOptions["unitOfWork"]): HarnessOptions {
    return {
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
    };
  }

  it("plays the same six-round game, chapel fight included, to the same transcript", async () => {
    const memory = await runHarness(options(new InMemoryCampaignStore()));
    const file = disk();
    const durable = await runHarness(options(file.open()));
    expect(renderReport(durable, summarizeRun(durable))).toBe(renderReport(memory, summarizeRun(memory)));
    expect(durable.events).toEqual(memory.events);
    expect(durable.finalState).toEqual(memory.finalState);
  });
});
