
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

export const starter = loadStarterAdventure();
export const guildId = "g-1";
export const quiet: RuntimeLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class Recording implements CampaignPresenter {
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

export interface Rig {
  store: InMemoryCampaignStore;
  clock: ManualClock;
  bus: CampaignCommandBus;
  service: CampaignLobbyService;
  presenter: Recording;
  plannerScript: ScriptedProposal[];
  runtime: (bootId?: string) => CampaignRuntime;
}

export function rig(store = new InMemoryCampaignStore(), clock = new ManualClock(1_000)): Rig {
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

export async function startedCampaign(r: Rig, pacing: { preset: "live" | "playByPost" } = { preset: "live" }): Promise<CampaignKey> {
  const created = await r.service.create({ guildId, organizerId: "u-org", name: "Moonlit Ruins", language: "en", adventureId: starterAdventureId, pacing });
  if (created.kind !== "ok") throw new Error("create");
  const { key } = created.value;
  await r.service.join(key, "u-org");
  await r.service.chooseHero(key, "u-org", starter.en.heroes[0]?.id ?? "");
  const started = await r.service.start(key, "u-org");
  if (started.kind !== "ok") throw new Error("start");
  return key;
}

