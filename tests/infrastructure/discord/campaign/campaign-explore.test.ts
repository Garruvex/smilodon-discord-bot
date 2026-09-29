import { describe, expect, it } from "vitest";

import { CampaignPlayController } from "../../../../src/application/campaign/campaign-play-controller.js";
import { CampaignRuntime } from "../../../../src/application/campaign/campaign-runtime.js";
import { SeededRandomSource } from "../../../../src/application/campaign/random/seeded-random-source.js";
import { ScriptedNarrator, ScriptedPlanner } from "../../../../src/application/campaign/dm/scripted-dm.js";
import { DeliveryWorker } from "../../../../src/application/campaign/workers/delivery-worker.js";
import { DmJobWorker } from "../../../../src/application/campaign/workers/dm-job-worker.js";
import { RollWorker } from "../../../../src/application/campaign/workers/roll-worker.js";
import { TimerWorker } from "../../../../src/application/campaign/workers/timer-worker.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { CampaignState } from "../../../../src/domain/campaign/state/campaign-state.js";
import { starterAdventureId } from "../../../../src/infrastructure/campaign/starter-adventures.js";
import { CampaignCardService } from "../../../../src/infrastructure/discord/campaign/campaign-card-service.js";
import { DiscordCampaignPresenter } from "../../../../src/infrastructure/discord/campaign/campaign-presenter.js";
import { guildId, quiet, rig, starter, tellOpening } from "../../../application/campaign/campaign-rig.js";
import { contentOf, fakeInteraction, harness, started, type Harness, type Sent } from "./handler-harness.js";
import { FakeMessages } from "./fake-messages.js";

// ---- the private screens ------------------------------------------------------

interface Screen {
  readonly content: string;
  readonly menus: { id: string; options: { value: string; label: string; description?: string; default?: boolean }[] }[];
  readonly buttons: { id: string; label: string; disabled: boolean }[];
}

function screenOf(sent: readonly Sent[]): Screen {
  const last = [...sent].reverse().find((entry) => entry.kind === "edit");
  const payload = last?.payload as { content?: string; components?: { toJSON(): { components: Record<string, unknown>[] } }[] } | undefined;
  const menus: Screen["menus"] = [];
  const buttons: Screen["buttons"] = [];
  for (const row of payload?.components ?? []) {
    for (const component of row.toJSON().components) {
      if (Array.isArray(component.options)) menus.push({ id: String(component.custom_id), options: component.options as Screen["menus"][number]["options"] });
      else buttons.push({ id: String(component.custom_id), label: String(component.label), disabled: component.disabled === true });
    }
  }
  return { content: payload?.content ?? "", menus, buttons };
}

async function choose(t: Harness, customId: string, value: string, userId = "u-org"): Promise<Sent[]> {
  const { interaction, sent } = fakeInteraction({ customId, userId, values: [value], kind: "select" });
  await t.handler.execute({ interaction, logger: quiet as never });
  return sent;
}

async function click(t: Harness, customId: string, userId = "u-org"): Promise<Sent[]> {
  const { interaction, sent } = fakeInteraction({ customId, userId, kind: "button" });
  await t.handler.execute({ interaction, logger: quiet as never });
  return sent;
}

const id = (t: Harness, action: string, argument?: string): string => `dnd:${action}:${t.key.campaignId}${argument === undefined ? "" : `:${argument}`}`;

// A started game where the hero has gold to spend and a ritual and a cantrip to cast.
async function table(): Promise<{ t: Harness; heroId: string }> {
  const t = await harness();
  await started(t);
  const stored = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
  const heroId = stored?.state.members["u-org"]?.characterId ?? "";
  await t.r.store.transaction(async (tx) => {
    const latest = await tx.loadCampaign(t.key);
    const sheet = latest?.state.characters[heroId];
    if (latest === undefined || sheet === undefined) throw new Error("state");
    await tx.saveCampaign(
      t.key,
      {
        ...latest.state,
        gold: 100,
        characters: { ...latest.state.characters, [heroId]: { ...sheet, spellcasting: { ability: "int", spells: ["spell:mage-hand", "spell:detect-magic", "spell:identify", "spell:sleep"], slots: { 1: 2 } } } },
      },
      latest.revision,
    );
  });
  return { t, heroId };
}

const stateOf = async (t: Harness): Promise<{ state: CampaignState }> => {
  const stored = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
  if (stored === undefined) throw new Error("state");
  return stored;
};

describe("Explore: the people in the scene", () => {
  it("lists who is here and marks the ones who trade, with a way to cast when the hero can", async () => {
    const { t } = await table();
    const home = screenOf(await t.press("explore", "u-org"));
    expect(home.content).toContain("Borin · between fights");
    expect(home.menus[0]?.id).toBe(id(t, "exploreNpc"));
    expect(home.menus[0]?.options.map((option) => option.label)).toEqual(["Garrick"]);
    expect(home.menus[0]?.options[0]?.description).toContain("trades");
    expect(home.buttons.map((button) => button.label)).toEqual(["Cast a spell"]);
  });

  it("says so when nobody is here and the hero has nothing to cast", async () => {
    const t = await harness();
    await started(t);
    // The watchtower has nobody in it.
    await t.r.store.transaction(async (tx) => {
      const latest = await tx.loadCampaign(t.key);
      if (latest === undefined) throw new Error("state");
      await tx.saveCampaign(t.key, { ...latest.state, sceneId: "scene:old-watchtower" }, latest.revision);
    });
    const home = screenOf(await t.press("explore", "u-org"));
    expect(home.content).toContain("nobody here to talk to");
    expect(home.menus).toEqual([]);
    expect(home.buttons).toEqual([]);
  });

  it("opens a person with Ask, Press and Shop, and refuses someone who is not in this scene", async () => {
    const { t } = await table();
    const npc = screenOf(await choose(t, id(t, "exploreNpc"), "npc:garrick"));
    expect(npc.content).toContain("**Garrick**");
    expect(npc.content).toContain("polishing the same mug");
    expect(npc.buttons.map((button) => button.label)).toEqual(["Ask a question", "Press for a secret", "Shop", "Back"]);
    // Skarn is not in the inn, whatever the menu was made to say.
    expect(screenOf(await choose(t, id(t, "exploreNpc"), "npc:skarn")).content).toContain("They are not here right now.");
    const back = screenOf(await click(t, id(t, "exploreBack", "garrick")));
    expect(back.content).toContain("**Garrick**");
    expect(screenOf(await click(t, id(t, "exploreHome"))).content).toContain("between fights");
  });
});

describe("Explore: asking and pressing", () => {
  it("opens a form for the question, and sends it to the person", async () => {
    const { t, heroId } = await table();
    const opened = await click(t, id(t, "exploreAsk", "garrick"));
    const modal = (opened.find((entry) => entry.kind === "modal")?.payload as { toJSON(): { custom_id: string; title: string; components: { components: { custom_id: string; max_length: number }[] }[] } }).toJSON();
    expect(modal.custom_id).toBe(id(t, "exploreAskSubmit", "garrick"));
    expect(modal.title).toBe("Ask Garrick");
    expect(modal.components[0]?.components[0]).toMatchObject({ custom_id: "question", max_length: 300 });

    const { interaction, sent } = fakeInteraction({ customId: id(t, "exploreAskSubmit", "garrick"), userId: "u-org", fields: { question: "Seen anything odd on the road?" }, kind: "modal" });
    await t.handler.executeModal({ interaction, logger: quiet as never });
    expect(contentOf(sent)).toContain("Your question is with Garrick");
    const queued = await t.r.store.transaction((tx) => tx.pendingOutbox("narrateDialogue"));
    expect(queued).toHaveLength(1);
    expect((await stateOf(t)).state.dialogues["dialogue:1"]).toMatchObject({ characterId: heroId, npcId: "npc:garrick", kind: "ask", question: "Seen anything odd on the road?" });
  });

  it("says why an empty question or a stranger's hero cannot ask", async () => {
    const { t } = await table();
    const { interaction, sent } = fakeInteraction({ customId: id(t, "exploreAskSubmit", "garrick"), userId: "u-org", fields: { question: "   " }, kind: "modal" });
    await t.handler.executeModal({ interaction, logger: quiet as never });
    expect(contentOf(sent)).not.toContain("Your question is with");
    const other = fakeInteraction({ customId: id(t, "exploreAskSubmit", "garrick"), userId: "u-stranger", fields: { question: "Hello?" }, kind: "modal" });
    await t.handler.executeModal({ interaction: other.interaction, logger: quiet as never });
    expect(contentOf(other.sent)).toContain("You do not have a hero");
  });

  it("presses for the secret over a hard check the player picks the skill for", async () => {
    const { t, heroId } = await table();
    const press = screenOf(await click(t, id(t, "explorePress", "garrick")));
    expect(press.content).toContain("hard check (DC 20)");
    expect(press.menus[0]?.options.map((option) => option.value)).toEqual(["insight", "persuasion", "deception", "intimidation"]);
    const sent = screenOf(await choose(t, id(t, "explorePressPick", "garrick"), "intimidation"));
    expect(sent.content).toContain("You press Garrick");
    expect((await stateOf(t)).state.pressPending?.[heroId]).toMatchObject({ npcId: "npc:garrick", test: { kind: "skill", skill: "intimidation" }, dc: 20 });
    // One at a time.
    expect(screenOf(await choose(t, id(t, "explorePressPick", "garrick"), "insight")).content).toContain("press roll waiting");
  });

  it("does not offer to press for a secret already won", async () => {
    const { t } = await table();
    await t.r.store.transaction(async (tx) => {
      const latest = await tx.loadCampaign(t.key);
      if (latest === undefined) throw new Error("state");
      await tx.saveCampaign(t.key, { ...latest.state, npcSecretsRevealed: { "npc:garrick": true } }, latest.revision);
    });
    const npc = screenOf(await choose(t, id(t, "exploreNpc"), "npc:garrick"));
    expect(npc.content).toContain("You already know their secret.");
    expect(npc.buttons.find((button) => button.label === "Press for a secret")?.disabled).toBe(true);
  });
});

describe("Explore: the shop", () => {
  it("shows the wares, what the hero can sell, and what the hero can pay", async () => {
    const { t } = await table();
    const shop = screenOf(await click(t, id(t, "exploreShop", "garrick.n")));
    expect(shop.content).toContain("**Garrick's wares**");
    expect(shop.content).toContain("You have 100 gp (the party purse).");
    expect(shop.content).toContain("• Potion of Healing · 50 gp");
    expect(shop.content).toContain("They will buy from you");
    // Borin carries a longsword, which Garrick buys; his chain mail is not on the list.
    expect(shop.content).toContain("• Longsword · 7 gp");
    expect(shop.content).not.toContain("Chain Mail");
    expect(shop.menus.map((menu) => menu.id)).toEqual([id(t, "exploreBuy", "garrick.n"), id(t, "exploreSell", "garrick.n"), id(t, "exploreHaggle", "garrick.n")]);
    expect(shop.menus[2]?.options.map((option) => option.label)).toEqual(["No haggling: the listed price", "Haggle with Persuasion (a check, DC 15)", "Haggle with Deception (a check, DC 15)", "Haggle with Intimidation (a check, DC 15)"]);
  });

  it("buys at the listed price, and sells back", async () => {
    const { t, heroId } = await table();
    const bought = screenOf(await choose(t, id(t, "exploreBuy", "garrick.n"), "item:dagger"));
    expect(bought.content).toContain("Sent to Garrick");
    expect(bought.content).toContain("You have 98 gp");
    const after = (await stateOf(t)).state;
    expect(after.gold).toBe(98);
    expect(after.characters[heroId]?.equipment).toContain("item:dagger");
    expect(await t.r.store.transaction((tx) => tx.pendingOutbox("narrateTrade"))).toHaveLength(1);

    const sold = screenOf(await choose(t, id(t, "exploreSell", "garrick.n"), "item:longsword"));
    expect(sold.content).toContain("You have 105 gp");
    expect((await stateOf(t)).state.characters[heroId]?.equipment).not.toContain("item:longsword");
  });

  it("refuses what the hero cannot afford, does not hold, or the shop does not sell", async () => {
    const { t } = await table();
    await t.r.store.transaction(async (tx) => {
      const latest = await tx.loadCampaign(t.key);
      if (latest === undefined) throw new Error("state");
      await tx.saveCampaign(t.key, { ...latest.state, gold: 10 }, latest.revision);
    });
    expect(screenOf(await choose(t, id(t, "exploreBuy", "garrick.n"), "item:potion-of-healing")).content).toContain("costs more gold");
    // A tampered menu value is not in the stock, and the price is never the client's to say.
    expect(screenOf(await choose(t, id(t, "exploreBuy", "garrick.n"), "item:greataxe")).content).toContain("They do not trade that.");
    expect(screenOf(await choose(t, id(t, "exploreSell", "garrick.n"), "item:javelin")).content).toContain("not carrying that");
    expect((await stateOf(t)).state.gold).toBe(10);
  });

  it("keeps the haggle choice in the controls, and haggles over a real check instead of buying at once", async () => {
    const { t, heroId } = await table();
    const picked = screenOf(await choose(t, id(t, "exploreHaggle", "garrick.n"), "p"));
    expect(picked.menus[0]?.id).toBe(id(t, "exploreBuy", "garrick.p"));
    expect(picked.menus[2]?.options.find((option) => option.default === true)?.label).toContain("Persuasion");
    const haggled = screenOf(await choose(t, id(t, "exploreBuy", "garrick.p"), "item:longsword"));
    expect(haggled.content).toContain("Sent to Garrick");
    const after = (await stateOf(t)).state;
    // The check is pending; nothing is bought or spent until the dice land.
    expect(after.hagglePending?.[heroId]).toMatchObject({ itemId: "item:longsword", direction: "buy", listedPrice: 15, test: { kind: "skill", skill: "persuasion" } });
    expect(after.gold).toBe(100);
  });
});

describe("Explore: casting between fights", () => {
  it("offers only the cantrips and rituals the hero knows, and casts one for the table", async () => {
    const { t } = await table();
    const cast = screenOf(await click(t, id(t, "exploreCast")));
    // Sleep is a slotted spell with no place between fights.
    expect(cast.menus[0]?.options.map((option) => option.value)).toEqual(["spell:mage-hand", "spell:detect-magic", "spell:identify"]);
    expect(cast.menus[0]?.options.map((option) => option.description)).toEqual(["Cantrip", "Ritual", "Ritual"]);
    const done = screenOf(await choose(t, id(t, "exploreCastPick"), "spell:detect-magic"));
    expect(done.content).toContain("You cast Detect Magic.");
    expect(await t.r.store.transaction((tx) => tx.pendingOutbox("narrateUtilityCast"))).toHaveLength(1);
    // A spell the hero does not know, however the value got there.
    expect(screenOf(await choose(t, id(t, "exploreCastPick"), "spell:comprehend-languages")).content).toContain("cannot cast that spell");
  });

  it("has nothing to cast for a hero with no such spells", async () => {
    const t = await harness();
    await started(t);
    expect(screenOf(await click(t, id(t, "exploreCast"))).content).toContain("no cantrip or ritual");
  });
});

// ---- what the table reads --------------------------------------------------------

describe("what the table is told", () => {
  async function play(): Promise<{
    controller: CampaignPlayController;
    settle: () => Promise<void>;
    said: () => string[];
    heroId: string;
    r: ReturnType<typeof rig>;
    key: Awaited<ReturnType<typeof table>>["t"]["key"];
  }> {
    const r = rig();
    const messages = new FakeMessages();
    const glossaries = { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary };
    const cards = new CampaignCardService({ unitOfWork: r.store, rulesets: r.rulesets, adventures: r.adventures, messages, glossaries, logger: quiet });
    const presenter = new DiscordCampaignPresenter({ unitOfWork: r.store, messages, cards, adventures: r.adventures, glossaries });
    const runtime = new CampaignRuntime({
      unitOfWork: r.store,
      bus: r.bus,
      rolls: new RollWorker(r.store, r.bus, new SeededRandomSource(3), r.clock),
      timers: new TimerWorker(r.store, r.bus, r.clock),
      dm: new DmJobWorker({ unitOfWork: r.store, bus: r.bus, planner: new ScriptedPlanner(r.plannerScript), narrator: new ScriptedNarrator([]), adventures: r.adventures, glossaries }),
      delivery: new DeliveryWorker(r.store, presenter),
      logger: quiet,
      bootId: "boot",
    });
    const created = await r.service.create({ guildId, organizerId: "u-org", name: "Moonlit Ruins", language: "en", adventureId: starterAdventureId, pacing: { preset: "live" } });
    if (created.kind !== "ok") throw new Error("create");
    const { key } = created.value;
    await r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, partyPostId: "chan-party", adventurePostId: "chan-adventure" } }, stored.revision);
    });
    const heroId = starter.en.heroes[0]?.id ?? "";
    await r.service.join(key, "u-org");
    await r.service.chooseHero(key, "u-org", heroId);
    await r.service.start(key, "u-org");
    await tellOpening(r, key);
    await r.store.transaction(async (tx) => {
      const latest = await tx.loadCampaign(key);
      const sheet = latest?.state.characters[heroId];
      if (latest === undefined || sheet === undefined) throw new Error("state");
      await tx.saveCampaign(key, { ...latest.state, gold: 100, characters: { ...latest.state.characters, [heroId]: { ...sheet, spellcasting: { ability: "int", spells: ["spell:detect-magic"], slots: {} } } } }, latest.revision);
    });
    await cards.sync(key);
    const controller = new CampaignPlayController({ unitOfWork: r.store, bus: r.bus, refresher: cards, adventures: r.adventures });
    return {
      controller,
      settle: async (): Promise<void> => {
        for (let pass = 0; pass < 6; pass += 1) await runtime.runOnce();
      },
      said: (): string[] => messages.posts.filter((post) => post.channelId === "chan-adventure").map((post) => post.content),
      heroId,
      r,
      key,
    };
  }

  it("tells a purchase with the price and the shopkeeper's answer", async () => {
    const g = await play();
    expect(await g.controller.trade(g.key, "u-org", { npcId: "npc:garrick", itemId: "item:dagger", direction: "buy" }, "i-1")).toEqual({ kind: "ok" });
    await g.settle();
    const line = g.said().find((text) => text.includes("buys Dagger"));
    expect(line).toContain("**Borin** buys Dagger from **Garrick** for 2 gp.");
  });

  it("tells a haggle with its check and the listed price", async () => {
    const g = await play();
    expect(await g.controller.trade(g.key, "u-org", { npcId: "npc:garrick", itemId: "item:longsword", direction: "buy", haggle: "persuasion" }, "i-1")).toEqual({ kind: "ok" });
    await g.settle();
    const line = g.said().find((text) => text.includes("from **Garrick**"));
    expect(line).toMatch(/Persuasion \(CHA\) \d+ against DC 15: (success|failure)\. Listed at 15 gp\./);
  });

  it("tells a question and a press with what the dice said", async () => {
    const g = await play();
    await g.controller.ask(g.key, "u-org", "npc:garrick", "Seen anything odd on the road?", "i-1");
    await g.controller.press(g.key, "u-org", "npc:garrick", "insight", "i-2");
    await g.settle();
    const said = g.said().join("\n");
    expect(said).toContain("**Borin** asks **Garrick**: “Seen anything odd on the road?”");
    expect(said).toMatch(/\*\*Borin\*\* presses \*\*Garrick\*\* with Insight \(WIS\)\. \*\d+ against DC 20: (success|failure)\.\*/);
  });

  it("tells a spell cast between fights", async () => {
    const g = await play();
    await g.controller.castSpell(g.key, "u-org", "spell:detect-magic", "i-1");
    await g.settle();
    expect(g.said().join("\n")).toContain("✨ **Borin** casts **Detect Magic**.");
  });

  it("puts a hazard on the whole party, or one hero, and tells the save and its cost", async () => {
    const g = await play();
    // Organizer only: the organizer's own click, and a DnD Admin acting for them, are the same right.
    expect(await g.controller.hazard(g.key, "u-x", "party", "con", 25, "i-0")).toMatchObject({ kind: "refused" });
    expect(await g.controller.hazard(g.key, null, "party", "con", 30, "i-1")).toEqual({ kind: "ok" });
    await g.settle();
    const said = g.said().join("\n");
    expect(said).toMatch(/⚠️ \*\*Borin\*\* makes a Constitution save against DC 30: \d+, (success|failure)\./);
  });

  it("checks the person, the price and the hazard before the engine sees them", async () => {
    const g = await play();
    expect(await g.controller.ask(g.key, "u-org", "npc:skarn", "Hello?", "i-1")).toEqual({ kind: "refused", reason: "npcNotHere" });
    expect(await g.controller.trade(g.key, "u-org", { npcId: "npc:garrick", itemId: "item:greataxe", direction: "buy" }, "i-2")).toEqual({ kind: "refused", reason: "notForSale" });
    // Garrick lists the dagger, but not to buy back a spear he never priced.
    expect(await g.controller.trade(g.key, "u-org", { npcId: "npc:garrick", itemId: "item:spear", direction: "sell" }, "i-3")).toEqual({ kind: "refused", reason: "notForSale" });
    expect(await g.controller.hazard(g.key, null, "party", "con", 3, "i-4")).toEqual({ kind: "refused", reason: "invalidHazard" });
    expect(await g.controller.hazard(g.key, null, "party", "nope" as never, 15, "i-5")).toEqual({ kind: "refused", reason: "invalidHazard" });
  });
});
