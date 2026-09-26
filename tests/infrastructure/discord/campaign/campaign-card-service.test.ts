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
    expect(Object.keys(record?.cards ?? {}).sort()).toEqual(["adventure", `hero:${firstHero}`, "hub", "party"]);
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
    // Nothing was saved for the card that failed to draw.
    expect(Object.keys((await r.service.get(key))?.record.cards ?? {})).not.toContain("lobby");
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

  describe("the hub", () => {
    const texts = (messages: readonly Sent[]): string[] => messages.map((message) => flatten(message.payload).text);

    async function twoGames(r: Rig, messages: FakeMessages): Promise<{ cards: CampaignCardService; first: CampaignKey; second: CampaignKey }> {
      const cards = serviceFor(r, messages);
      const first = await lobby(r);
      const created = await r.service.create({ guildId, organizerId: "u-org", name: "Second Game", language: "en", adventureId: starterAdventureId, pacing: { preset: "live" } });
      if (created.kind !== "ok") throw new Error("create");
      const second = created.value.key;
      await r.store.transaction(async (tx) => {
        const stored = await tx.loadRecord(second);
        if (stored === undefined) throw new Error("record");
        await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, partyChannelId: "chan-party-2", adventureChannelId: "chan-adventure-2" } }, stored.revision);
      });
      await cards.sync(first);
      await cards.sync(second);
      return { cards, first, second };
    }

    it("posts a pinned control message first, then one message per game, each edited in place", async () => {
      const r = rig();
      const messages = new FakeMessages();
      const { cards, first } = await twoGames(r, messages);
      const live = messages.live(hub);
      expect(live).toHaveLength(3);
      const [control, one, two] = live;
      expect(flatten(control!.payload).buttons.map((button) => button.label)).toEqual(["Create game"]);
      expect(flatten(control!.payload).buttons.map((button) => button.id)).toEqual(["dndhub:create"]);
      expect(messages.pinned).toContain(control!.messageId);
      expect(flatten(one!.payload).text).toContain("Moonlit Ruins");
      expect(flatten(one!.payload).text).toContain("Lobby · 0 / 3 players");
      expect(flatten(one!.payload).text).toContain(`<#${party}>`);
      expect(flatten(two!.payload).text).toContain("Second Game");
      expect(flatten(one!.payload).buttons.map((button) => button.id)).toEqual([`dndhub:manage:${first.campaignId}`]);

      await r.service.join(first, "u-org");
      await cards.sync(first);
      expect(messages.live(hub).map((message) => message.messageId)).toEqual(live.map((message) => message.messageId));
      expect(flatten(messages.live(hub)[1]!.payload).text).toContain("1 / 3 players");
      expect((await r.store.transaction((tx) => tx.loadGuildSettings(guildId)))?.hubCard?.messageId).toBe(control!.messageId);
      expect((await r.service.get(first))?.record.cards.hub?.messageId).toBe(one!.messageId);
    });

    it("takes a finished game's message off the hub", async () => {
      const r = rig();
      const messages = new FakeMessages();
      const { cards, first } = await twoGames(r, messages);
      await r.service.end(first);
      await cards.sync(first);
      expect(texts(messages.live(hub)).some((text) => text.includes("Moonlit Ruins"))).toBe(false);
      expect(texts(messages.live(hub)).some((text) => text.includes("Second Game"))).toBe(true);
      expect((await r.service.get(first))?.record.cards.hub).toBeUndefined();
    });

    it("draws the control and the games again, in order, when the control message is deleted", async () => {
      const r = rig();
      const messages = new FakeMessages();
      const { cards } = await twoGames(r, messages);
      const control = messages.live(hub)[0]!;
      messages.deleted.add(control.messageId);
      await cards.handleMessagesDeleted(guildId, hub, [control.messageId]);
      const live = messages.live(hub);
      expect(live).toHaveLength(3);
      expect(flatten(live[0]!.payload).buttons.map((button) => button.label)).toEqual(["Create game"]);
      expect(texts(live.slice(1))).toEqual([expect.stringContaining("Moonlit Ruins"), expect.stringContaining("Second Game")]);
      expect(live[0]!.messageId).not.toBe(control.messageId);
      expect(messages.pinned).toContain(live[0]!.messageId);
    });

    it("draws a game's hub message again when only that message is deleted", async () => {
      const r = rig();
      const messages = new FakeMessages();
      const { cards, first } = await twoGames(r, messages);
      const gone = messages.live(hub)[1]!;
      messages.deleted.add(gone.messageId);
      await cards.handleMessagesDeleted(guildId, hub, [gone.messageId]);
      expect(messages.live(hub)).toHaveLength(3);
      expect(texts(messages.live(hub)).filter((text) => text.includes("Moonlit Ruins"))).toHaveLength(1);
      expect((await r.service.get(first))?.record.cards.hub?.messageId).not.toBe(gone.messageId);
    });

    it("draws a deleted game card again and ignores messages it deleted itself", async () => {
      const r = rig();
      const messages = new FakeMessages();
      const { cards, first } = await twoGames(r, messages);
      const lobbyCard = (await r.service.get(first))?.record.cards.lobby;
      if (lobbyCard === undefined) throw new Error("lobby card");
      messages.deleted.add(lobbyCard.messageId);
      await cards.handleMessagesDeleted(guildId, party, [lobbyCard.messageId]);
      await cards.sync(first);
      expect(messages.live(party)).toHaveLength(1);
      expect(messages.live(party)[0]!.messageId).not.toBe(lobbyCard.messageId);

      // The card the bot replaced is not a player deleting something.
      const before = messages.sent.length;
      const replaced = messages.sent.find((message) => message.removed);
      if (replaced !== undefined) await cards.handleMessagesDeleted(guildId, replaced.channelId, [replaced.messageId]);
      await cards.sync(first);
      expect(messages.sent.length).toBe(before);
    });

    it("checks each card against Discord on a repair and at startup, and draws a missing one", async () => {
      const r = rig();
      const messages = new FakeMessages();
      const { cards, first } = await twoGames(r, messages);
      const lobbyCard = (await r.service.get(first))?.record.cards.lobby;
      const hubCard = (await r.service.get(first))?.record.cards.hub;
      if (lobbyCard === undefined || hubCard === undefined) throw new Error("cards");
      // Deleted while nobody was listening: the content is unchanged, so a plain sync does not notice.
      messages.deleted.add(lobbyCard.messageId);
      messages.deleted.add(hubCard.messageId);
      await cards.sync(first);
      expect(messages.live(party)).toHaveLength(0);

      await cards.recoverAll();
      expect(messages.live(party)).toHaveLength(1);
      expect(texts(messages.live(hub)).filter((text) => text.includes("Moonlit Ruins"))).toHaveLength(1);
    });
  });
});
