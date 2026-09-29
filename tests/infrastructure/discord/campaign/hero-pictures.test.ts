import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import { CampaignCardService } from "../../../../src/infrastructure/discord/campaign/campaign-card-service.js";
import { HeroPictures, initialsOf } from "../../../../src/infrastructure/discord/campaign/hero-pictures.js";
import { starterAdventureId } from "../../../../src/infrastructure/campaign/starter-adventures.js";
import { enSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/en/srd-5.1.js";
import { zhTwSrd51Glossary } from "../../../../src/application/i18n/campaign/glossary/zh-TW/srd-5.1.js";
import type { GeneratedImage } from "../../../../src/application/campaign/ports/image-ports.js";
import { guildId, quiet, rig, starter, tellOpening } from "../../../application/campaign/campaign-rig.js";
import { FakeMessages } from "./fake-messages.js";

const wide = (): GeneratedImage => {
  const canvas = createCanvas(300, 200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#c33";
  context.fillRect(0, 0, 300, 200);
  return { bytes: canvas.toBuffer("image/png"), mediaType: "image/png" };
};

describe("initials", () => {
  it("takes a letter from each of two words, or the first character of a single name", () => {
    expect(initialsOf("Mira Vale")).toBe("MV");
    expect(initialsOf("  borin  ")).toBe("B");
    expect(initialsOf("艾莉亞")).toBe("艾");
    expect(initialsOf("Ana Maria de Souza")).toBe("AM");
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("a hero's thumbnail", () => {
  it("is the portrait cut square and small", async () => {
    const pictures = new HeroPictures({ portraitFor: (): Promise<GeneratedImage | undefined> => Promise.resolve(wide()) });
    const thumb = await pictures.thumbnail({ characterId: "char-1", name: "Mira", libraryCharacterId: "lc-1" });
    expect(thumb.name).toBe("hero-char-1.png");
    const image = await loadImage(thumb.bytes);
    expect([image.width, image.height]).toEqual([160, 160]);
  });

  it("is a tile with initials when there is no portrait, or the portrait cannot be read", async () => {
    const none = new HeroPictures();
    const tile = await none.thumbnail({ characterId: "char-2", name: "Borin Stone" });
    expect((await loadImage(tile.bytes)).width).toBe(160);
    const broken = new HeroPictures({ portraitFor: (): Promise<GeneratedImage | undefined> => Promise.resolve({ bytes: Buffer.from("not a picture"), mediaType: "image/png" }) });
    const fallback = await broken.thumbnail({ characterId: "char-2", name: "Borin Stone", libraryCharacterId: "lc" });
    expect((await loadImage(fallback.bytes)).width).toBe(160);
    // A failing lookup is the same as no portrait.
    const failing = new HeroPictures({ portraitFor: (): Promise<GeneratedImage | undefined> => Promise.reject(new Error("disk")) });
    expect((await loadImage((await failing.thumbnail({ characterId: "c", name: "X", libraryCharacterId: "lc" })).bytes)).width).toBe(160);
  });

  it("keeps a made thumbnail and gives the same bytes again", async () => {
    let lookups = 0;
    const pictures = new HeroPictures({
      portraitFor: (): Promise<GeneratedImage | undefined> => {
        lookups += 1;
        return Promise.resolve(wide());
      },
    });
    const subject = { characterId: "char-1", name: "Mira", libraryCharacterId: "lc-1" };
    const first = await pictures.thumbnail(subject);
    const second = await pictures.thumbnail(subject);
    expect(second).toBe(first);
    expect(lookups).toBe(2);
  });

  it("gives a name the same colour every time and different names their own", async () => {
    const pictures = new HeroPictures();
    const a = await pictures.thumbnail({ characterId: "a", name: "Mira" });
    const again = await new HeroPictures().thumbnail({ characterId: "a", name: "Mira" });
    const other = await pictures.thumbnail({ characterId: "b", name: "Borin" });
    expect(again.bytes.equals(a.bytes)).toBe(true);
    expect(other.bytes.equals(a.bytes)).toBe(false);
  });
});

describe("a hero's full picture", () => {
  it("is the stored portrait for a hero from a saved character, and nothing for anyone else", async () => {
    const portrait = wide();
    const pictures = new HeroPictures({ portraitFor: (id): Promise<GeneratedImage | undefined> => Promise.resolve(id === "lc-1" ? portrait : undefined) });
    expect(await pictures.full({ characterId: "c", name: "Mira", libraryCharacterId: "lc-1" })).toBe(portrait);
    expect(await pictures.full({ characterId: "c", name: "Mira", libraryCharacterId: "lc-2" })).toBeUndefined();
    expect(await pictures.full({ characterId: "c", name: "Mira" })).toBeUndefined();
    expect(await new HeroPictures().full({ characterId: "c", name: "Mira", libraryCharacterId: "lc-1" })).toBeUndefined();
  });
});

describe("thumbnails on the party's hero cards", () => {
  const party = "chan-party";
  const adventure = "chan-adventure";

  async function game(pictures: HeroPictures | undefined): Promise<{ messages: FakeMessages; cards: CampaignCardService; key: { guildId: string; campaignId: string } }> {
    const r = rig();
    const messages = new FakeMessages();
    const cards = new CampaignCardService({
      unitOfWork: r.store,
      rulesets: r.rulesets,
      adventures: r.adventures,
      messages,
      glossaries: { en: enSrd51Glossary, "zh-TW": zhTwSrd51Glossary },
      logger: quiet,
      ...(pictures === undefined ? {} : { pictures }),
    });
    const created = await r.service.create({ guildId, organizerId: "u-org", name: "Moonlit Ruins", language: "en", adventureId: starterAdventureId, pacing: { preset: "live" } });
    if (created.kind !== "ok") throw new Error("create");
    const { key } = created.value;
    await r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, partyPostId: party, adventurePostId: adventure } }, stored.revision);
      await tx.saveGuildSettings({ guildId, categoryId: null, hubChannelId: "chan-hub", hubCard: null });
    });
    const firstHero = starter.en.heroes[0]?.id ?? "";
    await r.service.join(key, "u-org");
    await r.service.chooseHero(key, "u-org", firstHero);
    await r.service.start(key, "u-org");
    await tellOpening(r, key);
    await cards.sync(key);
    return { messages, cards, key };
  }

  const heroMessage = (messages: FakeMessages): { payload: { files?: readonly { name: string; bytes: Buffer }[]; components: unknown[] } } => {
    const found = messages.live(party).find((message) => (message.payload.files ?? []).length > 0);
    if (found === undefined) throw new Error("no hero card with a picture");
    return found;
  };

  it("shows every hero with a thumbnail attached to the card, initials when they have no portrait", async () => {
    const { messages } = await game(new HeroPictures());
    const card = heroMessage(messages);
    expect(card.payload.files).toHaveLength(1);
    expect(card.payload.files?.[0]?.name).toContain("hero-");
    const json = JSON.stringify((card.payload.components[0] as { toJSON(): unknown }).toJSON());
    expect(json).toContain(`attachment://${card.payload.files?.[0]?.name}`);
    // The party card itself carries no picture.
    expect(messages.live(party).filter((message) => (message.payload.files ?? []).length > 0)).toHaveLength(1);
  });

  it("draws no thumbnails when none are wired", async () => {
    const { messages } = await game(undefined);
    expect(messages.live(party).every((message) => (message.payload.files ?? []).length === 0)).toBe(true);
  });

  it("leaves an unchanged card alone, sending its picture only once", async () => {
    const { messages, cards, key } = await game(new HeroPictures());
    const editsBefore = messages.edits.length;
    const sentBefore = messages.sent.length;
    await cards.sync(key);
    await cards.sync(key);
    expect(messages.edits).toHaveLength(editsBefore);
    expect(messages.sent).toHaveLength(sentBefore);
  });
});
