import { describe, expect, it } from "vitest";

import type { CampaignKey } from "../../../../src/application/campaign/ports/campaign-store.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import { CampaignCardService } from "../../../../src/infrastructure/discord/campaign/campaign-card-service.js";
import { starterAdventureId } from "../../../../src/infrastructure/campaign/starter-adventures.js";
import { guildId, quiet, rig, starter, type Rig } from "../../../application/campaign/campaign-rig.js";
import { flatten } from "./card-helpers.js";
import { FakeMessages, type Sent } from "./fake-messages.js";

const party = "chan-party";
const adventure = "chan-adventure";
const hub = "chan-hub";

async function lobby(r: Rig): Promise<CampaignKey> {
  const created = await r.service.create({
    guildId,
    organizerId: "u-org",
    name: "Moonlit Ruins",
    language: "en",
    adventureId: starterAdventureId,
    pacing: { preset: "live" },
  });
  if (created.kind !== "ok") throw new Error("create");
  const { key } = created.value;
  await r.store.transaction(async (tx) => {
    const stored = await tx.loadRecord(key);
    if (stored === undefined) throw new Error("record");
    await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, partyChannelId: party, adventureChannelId: adventure } }, stored.revision);
    await tx.saveGuildSettings({ guildId, categoryId: null, hubChannelId: hub, hubCard: null });
  });
  return key;
}

function serviceFor(r: Rig, messages: FakeMessages): CampaignCardService {
  return new CampaignCardService({
    unitOfWork: r.store,
    rulesets: r.rulesets,
    adventures: r.adventures,
    messages,
    glossaries: { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary },
    logger: quiet,
  });
}

const heroes = starter.en.heroes.map((hero) => hero.id);
const firstHero = heroes[0] ?? "";

function only(messages: readonly Sent[]): Sent {
  const message = messages[0];
  if (message === undefined) throw new Error("No message.");
  return message;
}

describe("the card service", () => {
  it("draws the lobby card once and leaves an unchanged card alone", async () => {
    const r = rig();
    const messages = new FakeMessages();
    const cards = serviceFor(r, messages);
    const key = await lobby(r);
    await cards.sync(key);
    expect(messages.live(party)).toHaveLength(1);
    expect(flatten(only(messages.live(party)).payload).text).toContain("Moonlit Ruins — Lobby");
    expect(messages.pinned).toContain("m1");
    const sentBefore = messages.sent.length;
    await cards.sync(key);
    expect(messages.sent).toHaveLength(sentBefore);
    expect(messages.edits).toEqual([]);
  });

  it("edits the lobby card in place when someone joins, and saves the reference", async () => {
    const r = rig();
    const messages = new FakeMessages();
    const cards = serviceFor(r, messages);
    const key = await lobby(r);
    await cards.sync(key);
    await r.service.join(key, "u-org");
    await cards.sync(key);
    expect(messages.edits).toContain("m1");
    expect(flatten(only(messages.live(party)).payload).text).toContain("Choosing a hero");
    const record = (await r.service.get(key))?.record;
    expect(record?.cards.lobby).toMatchObject({ channelId: party, messageId: "m1" });
    expect(record !== undefined && CampaignCardService.isCurrent(record, "lobby", "m1")).toBe(true);
    expect(record !== undefined && CampaignCardService.isCurrent(record, "lobby", "old")).toBe(false);
  });

  it("turns the lobby card into the campaign card in place when the adventure starts", async () => {
    const r = rig();
    const messages = new FakeMessages();
    const cards = serviceFor(r, messages);
    const key = await lobby(r);
    await r.service.join(key, "u-org");
    await r.service.chooseHero(key, "u-org", firstHero);
    await cards.sync(key);
    await r.service.start(key, "u-org");
    await cards.sync(key);

    const partyMessages = messages.live(party);
    expect(only(partyMessages).messageId).toBe("m1");
    expect(flatten(only(partyMessages).payload).text).toContain("Party");
    expect(partyMessages).toHaveLength(2);
    expect(flatten(partyMessages[1]?.payload ?? only(partyMessages).payload).text).toContain(starter.en.heroes[0]?.name ?? "");
    expect(messages.live(adventure)).toHaveLength(1);
    expect(flatten(only(messages.live(adventure)).payload).text).toContain("Round 1");
    const record = (await r.service.get(key))?.record;
    expect(Object.keys(record?.cards ?? {}).sort()).toEqual(["adventure", `hero:${firstHero}`, "party"]);
  });

  it("replaces the adventure panel at the next round and retires the old one", async () => {
    const r = rig();
    const messages = new FakeMessages();
    const cards = serviceFor(r, messages);
    const key = await lobby(r);
    await r.service.join(key, "u-org");
    await r.service.chooseHero(key, "u-org", firstHero);
    await r.service.start(key, "u-org");
    await cards.sync(key);
    const first = only(messages.live(adventure));
    r.plannerScript.push({ roundNumber: 1, actions: [{ characterId: firstHero, resolution: { kind: "automatic", reason: "Simple." } }] });
    await r.bus.execute(key, { kind: "submitAction", characterId: firstHero, text: "I look." }, { commandId: "a", actor: { kind: "user", userId: "u-org" } });
    // Same round: edited in place.
    await cards.sync(key);
    expect(messages.live(adventure).map((message) => message.messageId)).toEqual([first.messageId]);
    const runtime = r.runtime();
    await runtime.runOnce();
    await runtime.runOnce();
    await cards.sync(key);
    const live = messages.live(adventure);
    expect(live).toHaveLength(1);
    expect(only(live).messageId).not.toBe(first.messageId);
    expect(first.removed).toBe(true);
    expect(flatten(only(live).payload).text).toContain("Round 2");
  });

  it("replaces a card someone deleted, without duplicating the others", async () => {
    const r = rig();
    const messages = new FakeMessages();
    const cards = serviceFor(r, messages);
    const key = await lobby(r);
    await cards.sync(key);
    messages.deleted.add("m1");
    await r.service.join(key, "u-org");
    await cards.sync(key);
    expect(messages.live(party)).toHaveLength(1);
    expect(only(messages.live(party)).messageId).not.toBe("m1");
    expect((await r.service.get(key))?.record.cards.lobby?.messageId).toBe(only(messages.live(party)).messageId);
  });

  it("survives a failed send, saves nothing for it, and draws it on the next sync", async () => {
    const r = rig();
    const messages = new FakeMessages();
    const cards = serviceFor(r, messages);
    const key = await lobby(r);
    messages.failSends = 1;
    await cards.sync(key);
    expect((await r.service.get(key))?.record.cards).toEqual({});
    await cards.sync(key);
    expect(messages.live(party)).toHaveLength(1);
  });

  it("coalesces a burst of refresh requests, and ignores a campaign that does not exist", async () => {
    const r = rig();
    const messages = new FakeMessages();
    const cards = serviceFor(r, messages);
    const key = await lobby(r);
    for (let index = 0; index < 20; index += 1) cards.refresh(key);
    await cards.sync(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messages.live(party)).toHaveLength(1);
    expect(() => cards.refresh({ guildId, campaignId: "missing" })).not.toThrow();
  });

  it("lists every game on the hub in one message that is edited in place", async () => {
    const r = rig();
    const messages = new FakeMessages();
    const cards = serviceFor(r, messages);
    const key = await lobby(r);
    await cards.sync(key);
    expect(messages.live(hub)).toHaveLength(1);
    expect(flatten(only(messages.live(hub)).payload).text).toContain("Moonlit Ruins — lobby, 0 / 3 players");
    expect(flatten(only(messages.live(hub)).payload).text).toContain(`<#${party}>`);
    await r.service.join(key, "u-org");
    await cards.sync(key);
    expect(messages.live(hub)).toHaveLength(1);
    expect(flatten(only(messages.live(hub)).payload).text).toContain("1 / 3 players");
    expect((await r.store.transaction((tx) => tx.loadGuildSettings(guildId)))?.hubCard?.messageId).toBe(only(messages.live(hub)).messageId);
  });
});
