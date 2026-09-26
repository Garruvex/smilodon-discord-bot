import { describe, expect, it } from "vitest";

import { CampaignRuntime } from "../../../../src/application/campaign/campaign-runtime.js";
import type { CampaignKey } from "../../../../src/application/campaign/ports/campaign-store.js";
import type { EncounterSpec } from "../../../../src/domain/campaign/commands/campaign-command.js";
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
import { guildId, quiet, rig, starter, tellOpening, type Rig } from "../../../application/campaign/campaign-rig.js";
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
  await tellOpening(r, key);
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
    expect(posts.find((post) => post.content.startsWith("🎲"))?.content).toMatch(/^🎲 \*\*.+\*\* · Stealth \(DEX\): d20 \*\*\d+\*\* [+−] \d+ = \*\*\d+\*\* vs DC 15 — [✅❌]/);
    expect(posts.some((post) => post.content === "The night air stirs.")).toBe(true);
    const narrationOrder = posts.find((post) => post.content === "The night air stirs.")?.order ?? 0;
    const panel = t.messages.live(adventure).at(-1);
    expect(flatten(panel?.payload ?? (undefined as never)).text).toContain("Round 2");
    expect(t.messages.sent.findIndex((message) => message === panel)).toBeGreaterThanOrEqual(0);
    expect(narrationOrder).toBeGreaterThan(0);
  });

  it("signs a delivery's posts the same way on every retry, so Discord can drop a repeat", async () => {
    const t = await table();
    const presenter = new DiscordCampaignPresenter({ unitOfWork: t.r.store, messages: t.messages, cards: t.cards, adventures: t.r.adventures, glossaries });
    await presenter.present(t.key, { kind: "quietRound", roundNumber: 1 }, "outbox-7");
    await presenter.present(t.key, { kind: "quietRound", roundNumber: 1 }, "outbox-7");
    await presenter.present(t.key, { kind: "quietRound", roundNumber: 1 }, "outbox-8");
    const nonces = t.messages.posts.filter((post) => post.content.includes("Nobody acted")).map((post) => post.nonce);
    expect(nonces).toHaveLength(3);
    expect(nonces[0]).toBe(nonces[1]);
    expect(nonces[2]).not.toBe(nonces[0]);
    expect(nonces[0]?.length).toBeLessThanOrEqual(25);
    // With no delivery ID (a direct call) nothing is signed.
    await presenter.present(t.key, { kind: "quietRound", roundNumber: 1 });
    expect(t.messages.posts.filter((post) => post.content.includes("Nobody acted")).at(-1)?.nonce).toBeUndefined();
  });

  it("nudges only the players still being waited for, halfway through a long round", async () => {
    const t = await table();
    const presenter = new DiscordCampaignPresenter({ unitOfWork: t.r.store, messages: t.messages, cards: t.cards, adventures: t.r.adventures, glossaries });
    const target = { kind: "round", roundNumber: 1, closesAt: 90_000_000 } as const;
    await presenter.present(t.key, { kind: "timerReminder", target });
    const nudge = t.messages.posts.find((post) => post.content.startsWith("⏰"));
    expect(nudge?.content).toBe("⏰ <@u-org> — this round closes <t:90000:R>, and you have not answered yet.");
    expect(nudge?.mentions).toEqual(["u-org"]);
    // Once they have answered, or the round has moved on, there is nobody to nudge.
    await t.r.bus.execute(t.key, { kind: "pass", characterId: t.hero }, { commandId: "pass", actor });
    const before = t.messages.posts.length;
    await presenter.present(t.key, { kind: "timerReminder", target });
    expect(t.messages.posts.slice(before).filter((post) => post.content.startsWith("⏰"))).toEqual([]);
  });

  it("stages the dice reveal: the die is thrown, then the same message shows the result", async () => {
    const t = await table();
    const presenter = new DiscordCampaignPresenter({ unitOfWork: t.r.store, messages: t.messages, cards: t.cards, adventures: t.r.adventures, glossaries, revealDelayMs: 5 });
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
    const before = t.messages.posts.length;
    await presenter.present(t.key, { kind: "rollResult", checkId });
    const added = t.messages.posts.slice(before);
    // One message, first "rolls…", then rewritten to the result.
    expect(added).toHaveLength(1);
    expect(t.messages.textEdits).toHaveLength(1);
    expect(t.messages.textEdits[0]?.content).toMatch(/^🎲 \*\*.+\*\* · Stealth \(DEX\): d20/);
    expect(added[0]?.content).toBe(t.messages.textEdits[0]?.content);
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
    await t.runtime.runOnce();
    const before = t.messages.posts.length;
    await t.r.bus.execute(t.key, { kind: "pauseCampaign", reason: "organizer" }, { commandId: "p", actor });
    await t.runtime.runOnce();
    expect(t.messages.posts).toHaveLength(before);
    expect(flatten(t.messages.live(adventure).at(-1)?.payload ?? (undefined as never)).text).toContain("The organizer paused the campaign.");
  });
});

const scrap: EncounterSpec = {
  id: "enc-scrap",
  zones: [{ id: "yard", name: "Yard" }],
  edges: [],
  partyZoneId: "yard",
  monsters: [{ monsterId: "monster:goblin", zoneId: "yard", npcId: null, fleeBelowHpFraction: null }],
};

// The round is over and a scrap with one goblin has begun; initiative is rolled.
async function fightOn(t: Table): Promise<void> {
  await t.r.store.transaction(async (tx) => {
    const stored = await tx.loadCampaign(t.key);
    if (stored === undefined) throw new Error("state");
    await tx.saveCampaign(t.key, { ...stored.state, round: null }, stored.revision);
  });
  await t.r.bus.execute(t.key, { kind: "startEncounter", spec: scrap }, { commandId: "fight", actor });
  await t.runtime.runOnce();
}

describe("the presenter for speech and safety", () => {
  it("posts what a hero says in character, without pings", async () => {
    const t = await table();
    await t.r.bus.execute(t.key, { kind: "speak", characterId: t.hero, text: "Stay close, <@everyone>." }, { commandId: "s", actor });
    await t.runtime.runOnce();
    const post = t.messages.posts.find((entry) => entry.content.startsWith("💬"));
    expect(post?.content).toBe("💬 **Borin:** “Stay close, <@everyone>.”");
    expect(post?.mentions).toEqual([]);
  });

  it("announces a safety pause without saying who asked", async () => {
    const t = await table();
    await t.r.bus.execute(t.key, { kind: "pauseCampaign", reason: "safety" }, { commandId: "p", actor });
    await t.runtime.runOnce();
    const post = t.messages.posts.find((entry) => entry.content.includes("paused at a player's request"));
    expect(post?.content).not.toContain("u-org");
    expect(flatten(t.messages.live(adventure).at(-1)?.payload ?? (undefined as never)).text).toContain("paused at a player's request");
  });
});

describe("the presenter and offers", () => {
  it("pings the receiving player when an item is offered", async () => {
    const t = await table();
    const second = starter.en.heroes[1]?.id ?? "";
    await t.r.service.join(t.key, "u-two");
    await t.r.service.chooseHero(t.key, "u-two", second);
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      const base = stored?.state.characters[t.hero];
      if (stored === undefined || base === undefined) throw new Error("state");
      const sheet = { ...base, id: second, ownerUserId: "u-two", name: "Mira", equipment: [] };
      await tx.saveCampaign(
        t.key,
        { ...stored.state, characters: { ...stored.state.characters, [second]: sheet }, members: { ...stored.state.members, "u-two": { userId: "u-two", characterId: second, availability: "present", consecutiveMisses: 0 } } },
        stored.revision,
      );
    });
    await t.r.bus.execute(t.key, { kind: "offerItem", fromCharacterId: t.hero, toCharacterId: second, give: "item:longsword", want: null }, { commandId: "o", actor });
    await t.runtime.runOnce();
    const ping = t.messages.posts.find((post) => post.content.includes("offers you"));
    expect(ping?.mentions).toEqual(["u-two"]);
    expect(ping?.content).toBe("🎁 <@u-two>, **Borin** offers you **Longsword**. Answer in <#chan-party>.");
  });
});

describe("the presenter in a fight the players play", () => {
  it("pings the player whose turn it is, once", async () => {
    const t = await table();
    await fightOn(t);
    const pings = t.messages.posts.filter((post) => post.content.includes("it is **Borin**'s turn"));
    expect(pings).toHaveLength(1);
    expect(pings[0]?.mentions).toEqual(["u-org"]);
    expect(pings[0]?.content).toBe("⚔️ <@u-org>, it is **Borin**'s turn.");
  });

  it("posts a template line for each action, with hits and damage", async () => {
    const t = await table();
    await fightOn(t);
    await t.r.bus.execute(t.key, { kind: "combatEngage", combatantId: t.hero, targetId: "goblin" }, { commandId: "e", actor });
    await t.r.bus.execute(t.key, { kind: "combatAttack", combatantId: t.hero, targetId: "goblin", weapon: "item:longsword" }, { commandId: "a1", actor });
    await t.runtime.runOnce();
    const line = t.messages.posts.find((post) => post.content.startsWith("⚔️ **Borin** ·"))?.content ?? "";
    expect(line).toMatch(/^⚔️ \*\*Borin\*\* · Longsword → Goblin: (hit, \d+ damage|critical hit, \d+ damage|miss)/);
  });

  it("says when a hero takes the Dodge action", async () => {
    const t = await table();
    await fightOn(t);
    await t.r.bus.execute(t.key, { kind: "combatDodge", combatantId: t.hero }, { commandId: "d", actor });
    await t.runtime.runOnce();
    expect(t.messages.posts.some((post) => post.content === "🛡️ **Borin** takes the Dodge action.")).toBe(true);
  });

  it("stays quiet about individual actions when the heroes are on autopilot", async () => {
    const t = await table();
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(t.key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, houseRules: { ...stored.record.houseRules, "combat-mode": "autopilot" } }, stored.revision);
    });
    await fightOn(t);
    await t.r.bus.execute(t.key, { kind: "combatDodge", combatantId: t.hero }, { commandId: "d", actor });
    await t.runtime.runOnce();
    expect(t.messages.posts.some((post) => post.content.startsWith("⚔️") || post.content.startsWith("🛡️"))).toBe(false);
  });
});
