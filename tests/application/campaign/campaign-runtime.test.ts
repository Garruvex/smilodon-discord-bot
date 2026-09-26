import { describe, expect, it } from "vitest";

import { StaticAdventureLibrary } from "../../../src/application/campaign/adventures/static-adventure-library.js";
import { CampaignCommandBus } from "../../../src/application/campaign/campaign-command-bus.js";
import { CampaignLobbyService } from "../../../src/application/campaign/campaign-lobby-service.js";
import { CampaignRuntime, type RuntimeLogger } from "../../../src/application/campaign/campaign-runtime.js";
import { ScriptedNarrator, ScriptedPlanner, type ScriptedProposal } from "../../../src/application/campaign/dm/scripted-dm.js";
import type { CampaignPresenter } from "../../../src/application/campaign/ports/campaign-presenter.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { SeededRandomSource } from "../../../src/application/campaign/random/seeded-random-source.js";
import { RulesetCatalog } from "../../../src/application/campaign/rules/ruleset-catalog.js";
import { ManualClock } from "../../../src/application/campaign/time/manual-clock.js";
import { DeliveryWorker } from "../../../src/application/campaign/workers/delivery-worker.js";
import { DmJobWorker } from "../../../src/application/campaign/workers/dm-job-worker.js";
import { RollWorker } from "../../../src/application/campaign/workers/roll-worker.js";
import { TimerWorker } from "../../../src/application/campaign/workers/timer-worker.js";
import { enSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { DeliverySpec } from "../../../src/domain/campaign/engine/engine-request.js";
import { loadStarterAdventure, starterAdventureId } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { InMemoryCampaignStore } from "../../../src/infrastructure/persistence/campaign/in-memory-campaign-store.js";
import { ruleset } from "../../domain/campaign/campaign-fixtures.js";

const starter = loadStarterAdventure();
const guildId = "g-1";
const quiet: RuntimeLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

class Recording implements CampaignPresenter {
  public readonly delivered: DeliverySpec[] = [];
  public failNext = 0;
  public present(_key: CampaignKey, delivery: DeliverySpec): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error("Discord is down."));
    }
    this.delivered.push(delivery);
    return Promise.resolve();
  }
}

interface Rig {
  store: InMemoryCampaignStore;
  clock: ManualClock;
  bus: CampaignCommandBus;
  service: CampaignLobbyService;
  presenter: Recording;
  plannerScript: ScriptedProposal[];
  runtime: (bootId?: string) => CampaignRuntime;
}

function rig(store = new InMemoryCampaignStore(), clock = new ManualClock(1_000)): Rig {
  const content = ruleset().content;
  const rulesets = new RulesetCatalog([content]);
  const bus = new CampaignCommandBus({ unitOfWork: store, rulesets, clock });
  const adventures = new StaticAdventureLibrary([{ id: starterAdventureId, editions: starter }]);
  const presenter = new Recording();
  const plannerScript: ScriptedProposal[] = [];
  const planner = new ScriptedPlanner(plannerScript);
  const narrator = new ScriptedNarrator(Array.from({ length: 5 }, () => ({ text: "The night air stirs." })));
  const service = new CampaignLobbyService({
    unitOfWork: store,
    bus,
    adventures,
    clock,
    ruleset: { rulesetId: content.rulesetId, rulesetVersion: content.version, houseRules: {} },
  });
  const dm = new DmJobWorker({
    unitOfWork: store,
    bus,
    planner,
    narrator,
    adventures,
    glossaries: { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary },
  });
  return {
    store,
    clock,
    bus,
    service,
    presenter,
    plannerScript,
    runtime: (bootId = "boot-1"): CampaignRuntime =>
      new CampaignRuntime({
        unitOfWork: store,
        bus,
        rolls: new RollWorker(store, bus, new SeededRandomSource(1), clock),
        timers: new TimerWorker(store, bus, clock),
        dm,
        delivery: new DeliveryWorker(store, presenter),
        logger: quiet,
        bootId,
      }),
  };
}

async function startedCampaign(r: Rig, pacing: { preset: "live" | "playByPost" } = { preset: "live" }): Promise<CampaignKey> {
  const created = await r.service.create({ guildId, organizerId: "u-org", name: "Moonlit Ruins", language: "en", adventureId: starterAdventureId, pacing });
  if (created.kind !== "ok") throw new Error("create");
  const { key } = created.value;
  await r.service.join(key, "u-org");
  await r.service.chooseHero(key, "u-org", starter.en.heroes[0]?.id ?? "");
  const started = await r.service.start(key, "u-org");
  if (started.kind !== "ok") throw new Error("start");
  return key;
}

const player = { kind: "user", userId: "u-org" } as const;

describe("the runtime", () => {
  it("drives a round from the player's action to narration and the next round, delivering each step", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    const heroId = starter.en.heroes[0]?.id ?? "";
    r.plannerScript.push({ roundNumber: 1, actions: [{ characterId: heroId, resolution: { kind: "automatic", reason: "Simple." } }] });

    await r.bus.execute(key, { kind: "submitAction", characterId: heroId, text: "I greet the innkeeper." }, { commandId: "act-1", actor: player });
    const runtime = r.runtime();
    await runtime.runOnce();
    await runtime.runOnce();

    const state = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(state?.lastNarratedRound).toBe(1);
    expect(state?.round).toMatchObject({ number: 2, status: "collecting" });
    expect(r.presenter.delivered.map((delivery) => delivery.kind)).toContain("narration");
  });

  it("keeps a campaign's deliveries in order and retries a failed one before the next", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    await r.store.transaction(async (tx) => {
      await tx.enqueue(key, "d1", { kind: "deliver", delivery: { kind: "quietRound", roundNumber: 1 } }, 1);
      await tx.enqueue(key, "d2", { kind: "deliver", delivery: { kind: "narration", roundNumber: 1 } }, 2);
    });
    const worker = new DeliveryWorker(r.store, r.presenter, 3);
    r.presenter.failNext = 1;
    // The first fails, so the second waits behind it.
    expect((await worker.runOnce()).failed).toHaveLength(1);
    expect(r.presenter.delivered.filter((delivery) => delivery.kind === "narration")).toHaveLength(0);
    await worker.runOnce();
    const kinds = r.presenter.delivered.map((delivery) => delivery.kind);
    expect(kinds.indexOf("quietRound")).toBeLessThan(kinds.indexOf("narration"));
  });

  it("gives up on a delivery after its attempts, without blocking forever", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    await r.store.transaction((tx) => tx.enqueue(key, "d1", { kind: "deliver", delivery: { kind: "quietRound", roundNumber: 1 } }, 1));
    const worker = new DeliveryWorker(r.store, r.presenter, 2);
    r.presenter.failNext = 5;
    await worker.runOnce();
    await worker.runOnce();
    r.presenter.failNext = 0;
    await worker.runOnce();
    expect(r.presenter.delivered.filter((delivery) => delivery.kind === "quietRound")).toHaveLength(0);
  });
});

describe("recovery after a restart", () => {
  it("pauses timed campaigns so no deadline fires unattended, until the organizer resumes", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    const restarted = r.runtime("boot-2");
    const report = await restarted.recover();
    expect(report.paused).toEqual([key]);

    // Hours later nothing fires, because the timers were cancelled.
    r.clock.advance(6 * 3600 * 1000);
    await restarted.runOnce();
    const paused = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(paused).toMatchObject({ status: "waitingForPlayers", pausedBy: "recovery" });
    expect(paused?.round?.submissions).toEqual({});

    const resumed = await r.bus.execute(key, { kind: "continue" }, { commandId: "resume", actor: { kind: "user", userId: "u-org" } });
    expect(resumed.kind).toBe("accepted");
    const after = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(after).toMatchObject({ status: "active", pausedBy: null });
  });

  it("does not pause a campaign twice for one start, and pauses again after the next", async () => {
    const r = rig();
    const key = await startedCampaign(r);
    await r.runtime("boot-2").recover();
    await r.bus.execute(key, { kind: "continue" }, { commandId: "resume", actor: { kind: "user", userId: "u-org" } });
    expect((await r.runtime("boot-2").recover()).paused).toEqual([key]);
    await r.bus.execute(key, { kind: "continue" }, { commandId: "resume-2", actor: { kind: "user", userId: "u-org" } });
    expect((await r.runtime("boot-3").recover()).paused).toEqual([key]);
  });

  it("opens the first round of a campaign that stopped before it, and leaves untimed campaigns running", async () => {
    const r = rig();
    const created = await r.service.create({
      guildId,
      organizerId: "u-org",
      name: "Untimed",
      language: "en",
      adventureId: starterAdventureId,
      pacing: { preset: "custom", pacing: { roundSeconds: null, rollSeconds: null, turnSeconds: null, awayAfterMisses: 2 } },
    });
    if (created.kind !== "ok") throw new Error("create");
    const { key } = created.value;
    await r.service.join(key, "u-org");
    await r.service.chooseHero(key, "u-org", starter.en.heroes[0]?.id ?? "");
    // Simulate the crash: the engine campaign exists but the first round never opened.
    await r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, lifecycle: "active", lobby: { ...stored.record.lobby, status: "started" }, startedAt: 1 }, stored.revision);
    });
    const { buildStartingState } = await import("../../../src/application/campaign/setup/starting-state.js");
    await r.store.transaction((tx) =>
      tx.createCampaign(key, {
        state: buildStartingState({
          campaignId: key.campaignId,
          organizerId: "u-org",
          adventure: starter.en,
          seats: [{ userId: "u-org", heroId: starter.en.heroes[0]?.id ?? "" }],
          pacing: { roundSeconds: null, rollSeconds: null, turnSeconds: null, awayAfterMisses: 2 },
        }),
        revision: 0,
        ruleset: { rulesetId: ruleset().content.rulesetId, rulesetVersion: ruleset().content.version, houseRules: {} },
        adventure: { adventureId: starterAdventureId, version: starter.en.bible.version },
      }),
    );
    const report = await r.runtime().recover();
    expect(report.firstRoundsOpened).toEqual([key]);
    expect(report.paused).toEqual([]);
    const state = (await r.store.transaction((tx) => tx.loadCampaign(key)))?.state;
    expect(state).toMatchObject({ status: "active", pausedBy: null, round: { number: 1, status: "collecting" } });
  });
});
