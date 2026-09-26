import { describe, expect, it } from "vitest";

import { CampaignRuntime } from "../../../../src/application/campaign/campaign-runtime.js";
import type { CampaignKey } from "../../../../src/application/campaign/ports/campaign-store.js";
import { SeededRandomSource } from "../../../../src/application/campaign/random/seeded-random-source.js";
import { DeliveryWorker } from "../../../../src/application/campaign/workers/delivery-worker.js";
import { DmJobWorker } from "../../../../src/application/campaign/workers/dm-job-worker.js";
import { RollWorker } from "../../../../src/application/campaign/workers/roll-worker.js";
import { TimerWorker } from "../../../../src/application/campaign/workers/timer-worker.js";
import { ScriptedNarrator, ScriptedPlanner } from "../../../../src/application/campaign/dm/scripted-dm.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { starterAdventureId } from "../../../../src/infrastructure/campaign/starter-adventures.js";
import { CampaignCardService } from "../../../../src/infrastructure/discord/campaign/campaign-card-service.js";
import { DiscordCampaignPresenter } from "../../../../src/infrastructure/discord/campaign/campaign-presenter.js";
import { guildId, quiet, rig, starter, type Rig } from "../../../application/campaign/campaign-rig.js";
import { flatten } from "./card-helpers.js";
import { FakeMessages } from "./fake-messages.js";

const party = "chan-party";
const adventure = "chan-adventure";
const glossaries = { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary };

interface Table {
  r: Rig;
  messages: FakeMessages;
  cards: CampaignCardService;
  runtime: CampaignRuntime;
  key: CampaignKey;
  hero: string;
}

async function table(language: "en" | "zh-TW" = "en"): Promise<Table> {
  const r = rig();
  const messages = new FakeMessages();
  const cards = new CampaignCardService({ unitOfWork: r.store, rulesets: r.rulesets, adventures: r.adventures, messages, glossaries, logger: quiet });
  const presenter = new DiscordCampaignPresenter({ unitOfWork: r.store, messages, cards, adventures: r.adventures, glossaries });
  const script = new ScriptedNarrator([{ text: "The night air stirs." }, { text: "Something moves." }]);
  const runtime = new CampaignRuntime({
    unitOfWork: r.store,
    bus: r.bus,
    rolls: new RollWorker(r.store, r.bus, new SeededRandomSource(1), r.clock),
    timers: new TimerWorker(r.store, r.bus, r.clock),
    dm: new DmJobWorker({ unitOfWork: r.store, bus: r.bus, planner: new ScriptedPlanner(r.plannerScript), narrator: script, adventures: r.adventures, glossaries }),
    delivery: new DeliveryWorker(r.store, presenter),
    logger: quiet,
    bootId: "boot",
  });
  const created = await r.service.create({ guildId, organizerId: "u-org", name: "Moonlit Ruins", language, adventureId: starterAdventureId, pacing: { preset: "live" } });
  if (created.kind !== "ok") throw new Error("create");
  const { key } = created.value;
  await r.store.transaction(async (tx) => {
    const stored = await tx.loadRecord(key);
    if (stored === undefined) throw new Error("record");
    await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, partyChannelId: party, adventureChannelId: adventure } }, stored.revision);
  });
  const hero = starter[language].heroes[0]?.id ?? "";
  await r.service.join(key, "u-org");
  await r.service.chooseHero(key, "u-org", hero);
  await r.service.start(key, "u-org");
  await cards.sync(key);
  return { r, messages, cards, runtime, key, hero };
}

const actor = { kind: "user", userId: "u-org" } as const;

describe("the presenter", () => {
  it("posts the roll result, then the narration, then a fresh panel below them", async () => {
    const t = await table();
    t.r.plannerScript.push({
      roundNumber: 1,
      actions: [{ characterId: t.hero, resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "medium", rollModeReasons: [] } }],
    });
    await t.r.bus.execute(t.key, { kind: "submitAction", characterId: t.hero, text: "I sneak in." }, { commandId: "a", actor });
    await t.runtime.runOnce();
    const state = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state;
    const checkId = Object.keys(state?.checks ?? {})[0] ?? "";
    await t.r.bus.execute(t.key, { kind: "requestRoll", checkId }, { commandId: "b", actor });
    await t.runtime.runOnce();
    await t.runtime.runOnce();

    const posts = t.messages.posts.filter((post) => post.channelId === adventure);
    expect(posts[0]?.content).toMatch(/^🎲 \*\*.+\*\* · Stealth \(DEX\): d20 \*\*\d+\*\* [+−] \d+ = \*\*\d+\*\* vs DC 15 — [✅❌]/);
    expect(posts.some((post) => post.content === "The night air stirs.")).toBe(true);
    const narrationOrder = posts.find((post) => post.content === "The night air stirs.")?.order ?? 0;
    const panel = t.messages.live(adventure).at(-1);
    expect(flatten(panel?.payload ?? (undefined as never)).text).toContain("Round 2");
    expect(t.messages.sent.findIndex((message) => message === panel)).toBeGreaterThanOrEqual(0);
    expect(narrationOrder).toBeGreaterThan(0);
  });

  it("says so when nobody acts in a round", async () => {
    const t = await table();
    await t.r.bus.execute(t.key, { kind: "pass", characterId: t.hero }, { commandId: "a", actor });
    await t.runtime.runOnce();
    expect(t.messages.posts.some((post) => post.content.includes("Nobody acted this round"))).toBe(true);
  });

  it("writes the roll line in Traditional Chinese with the English abbreviation", async () => {
    const t = await table("zh-TW");
    t.r.plannerScript.push({
      roundNumber: 1,
      actions: [{ characterId: t.hero, resolution: { kind: "check", test: { kind: "skill", skill: "stealth" }, dcTier: "medium", rollModeReasons: [] } }],
    });
    await t.r.bus.execute(t.key, { kind: "submitAction", characterId: t.hero, text: "我悄悄潛入。" }, { commandId: "a", actor });
    await t.runtime.runOnce();
    const state = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state;
    await t.r.bus.execute(t.key, { kind: "requestRoll", checkId: Object.keys(state?.checks ?? {})[0] ?? "" }, { commandId: "b", actor });
    await t.runtime.runOnce();
    const line = t.messages.posts.find((post) => post.content.startsWith("🎲"))?.content ?? "";
    expect(line).toContain("隱匿 (DEX)");
    expect(line).toContain("難度 15");
  });

  it("redraws the panel for a pause without posting history", async () => {
    const t = await table();
    const before = t.messages.posts.length;
    await t.r.bus.execute(t.key, { kind: "pauseCampaign", reason: "organizer" }, { commandId: "p", actor });
    await t.runtime.runOnce();
    expect(t.messages.posts).toHaveLength(before);
    expect(flatten(t.messages.live(adventure).at(-1)?.payload ?? (undefined as never)).text).toContain("The organizer paused the campaign.");
  });
});
