import { describe, expect, it } from "vitest";

import { CharacterPortraits, portraitPrompt, sniffImageType } from "../../../src/application/campaign/library/character-portraits.js";
import type { BuildChoices } from "../../../src/domain/campaign/character/character-build.js";
import { rig } from "./campaign-rig.js";
import { MemoryPortraitStore, Painter, pngBytes, Stylizer } from "./portrait-fakes.js";

const build: BuildChoices = {
  class: "rogue",
  race: "gnome",
  kit: "shadow",
  abilities: { str: 8, dex: 15, con: 12, int: 13, wis: 10, cha: 14 },
  skills: ["stealth", "perception", "acrobatics", "deception"],
  expertise: ["stealth", "perception"],
  name: "Wren",
  appearance: "Quick and quiet.",
  backstory: "",
};

async function setup(options: { stylizer?: boolean; generator?: boolean; maxPerHour?: number } = {}): Promise<{
  portraits: CharacterPortraits;
  store: MemoryPortraitStore;
  stylizer: Stylizer;
  painter: Painter;
  characterId: string;
  r: ReturnType<typeof rig>;
}> {
  const r = rig();
  const made = await r.library.create("u-alice", build);
  if (made.kind !== "ok") throw new Error("create");
  const store = new MemoryPortraitStore();
  const stylizer = new Stylizer();
  const painter = new Painter();
  const portraits = new CharacterPortraits({
    library: r.library,
    store,
    clock: r.clock,
    ...(options.stylizer === false ? {} : { stylizer }),
    ...(options.generator === false ? {} : { generator: painter }),
    ...(options.maxPerHour === undefined ? {} : { maxPerHour: options.maxPerHour }),
  });
  return { portraits, store, stylizer, painter, characterId: made.character.id, r };
}

describe("reading an upload", () => {
  it("knows a picture by its first bytes, not by what it claims", () => {
    expect(sniffImageType(pngBytes)).toBe("image/png");
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("RIFF1234WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(Buffer.from("<svg></svg>"))).toBeUndefined();
    expect(sniffImageType(Buffer.from("MZ executable"))).toBeUndefined();
  });
});

describe("the portrait prompt", () => {
  it("keeps the likeness when there is a reference, and paints from words when there is none", () => {
    const withPicture = portraitPrompt(build, "ink", "a red cloak", true);
    expect(withPicture).toContain("turn the person or figure in the reference picture");
    expect(withPicture).toContain("Wren, a gnome rogue");
    expect(withPicture).toContain("Quick and quiet. a red cloak");
    expect(withPicture).toContain("comic-book");
    expect(withPicture).toContain("No text");
    const fromWords = portraitPrompt(build, "watercolor", "", false);
    expect(fromWords).not.toContain("reference picture");
    expect(fromWords).toContain("a fantasy tabletop RPG character portrait of Wren");
  });
});

describe("making a portrait from an upload", () => {
  it("makes a candidate that waits for a yes, and keeps the upload only until then", async () => {
    const { portraits, store, stylizer, characterId } = await setup();
    const result = await portraits.fromUpload("u-alice", characterId, pngBytes, "painterly", "  silver armor  ");
    expect(result).toMatchObject({ kind: "ok", style: "painterly", fromUpload: true });
    expect(stylizer.requests[0]?.prompt).toContain("silver armor");
    expect(stylizer.requests[0]?.source.mediaType).toBe("image/png");
    expect(await portraits.current("u-alice", characterId)).toBeUndefined();
    expect(await portraits.candidate("u-alice", characterId)).toMatchObject({ style: "painterly", fromUpload: true });

    expect(await portraits.accept("u-alice", characterId)).toBe(true);
    expect((await portraits.current("u-alice", characterId))?.bytes.toString()).toBe("styled");
    // The picture the player sent is gone, and so is the candidate.
    expect(store.images.has(`${characterId}:source`)).toBe(false);
    expect(await portraits.candidate("u-alice", characterId)).toBeUndefined();
    // A game finds the portrait by the character alone.
    expect((await portraits.forGame(characterId))?.bytes.toString()).toBe("styled");
  });

  it("tries again from the same upload, in the same look or a new one", async () => {
    const { portraits, stylizer, characterId } = await setup();
    await portraits.fromUpload("u-alice", characterId, pngBytes, "painterly", "a red cloak");
    expect(await portraits.again("u-alice", characterId)).toMatchObject({ kind: "ok", style: "painterly" });
    expect(await portraits.again("u-alice", characterId, "ink")).toMatchObject({ kind: "ok", style: "ink" });
    expect(stylizer.requests).toHaveLength(3);
    // The same picture and the same words each time; only the look changes.
    expect(stylizer.requests[2]?.source.bytes.equals(pngBytes)).toBe(true);
    expect(stylizer.requests[2]?.prompt).toContain("a red cloak");
    expect(stylizer.requests[2]?.prompt).toContain("comic-book");
    expect(await portraits.candidate("u-alice", characterId)).toMatchObject({ style: "ink" });
  });

  it("lets a discarded candidate go, with its upload", async () => {
    const { portraits, store, characterId } = await setup();
    await portraits.fromUpload("u-alice", characterId, pngBytes, "ink", "");
    await portraits.discard("u-alice", characterId);
    expect(store.images.size).toBe(0);
    expect(await portraits.again("u-alice", characterId)).toEqual({ kind: "refused", reason: "noSource" });
  });

  it("refuses what is not a picture, a picture too large, and a character that is not theirs", async () => {
    const { portraits, characterId } = await setup();
    expect(await portraits.fromUpload("u-alice", characterId, Buffer.from("<svg onload=x>"), "ink", "")).toEqual({ kind: "refused", reason: "badType" });
    expect(await portraits.fromUpload("u-alice", characterId, Buffer.concat([pngBytes, Buffer.alloc(9 * 1024 * 1024)]), "ink", "")).toEqual({ kind: "refused", reason: "tooLarge" });
    expect(await portraits.fromUpload("u-bob", characterId, pngBytes, "ink", "")).toEqual({ kind: "refused", reason: "notFound" });
    // Someone else can neither see, take, nor remove it.
    await portraits.fromUpload("u-alice", characterId, pngBytes, "ink", "");
    expect(await portraits.candidate("u-bob", characterId)).toBeUndefined();
    expect(await portraits.accept("u-bob", characterId)).toBe(false);
  });

  it("reports a provider failure without keeping a candidate", async () => {
    const { portraits, stylizer, characterId } = await setup();
    stylizer.fail = true;
    expect(await portraits.fromUpload("u-alice", characterId, pngBytes, "ink", "")).toEqual({ kind: "refused", reason: "failed" });
    expect(await portraits.candidate("u-alice", characterId)).toBeUndefined();
  });

  it("is unavailable without an editing model, though painting from words still works", async () => {
    const { portraits, characterId } = await setup({ stylizer: false });
    expect(portraits.canUpload).toBe(false);
    expect(portraits.canPaint).toBe(true);
    expect(await portraits.fromUpload("u-alice", characterId, pngBytes, "ink", "")).toEqual({ kind: "refused", reason: "unavailable" });
    expect(await portraits.fromDescription("u-alice", characterId, "ink", "")).toMatchObject({ kind: "ok", fromUpload: false });
    const none = await setup({ stylizer: false, generator: false });
    expect(none.portraits.available).toBe(false);
  });
});

describe("painting from the description", () => {
  it("uses the build and the player's words, never a reference", async () => {
    const { portraits, painter, characterId } = await setup();
    const result = await portraits.fromDescription("u-alice", characterId, "realistic", "a scar");
    expect(result).toMatchObject({ kind: "ok", style: "realistic", fromUpload: false });
    expect(painter.prompts[0]).toContain("Wren, a gnome rogue");
    expect(painter.prompts[0]).toContain("a scar");
    expect(await portraits.again("u-alice", characterId, "ink")).toMatchObject({ kind: "ok", fromUpload: false });
    expect(painter.prompts).toHaveLength(2);
  });
});

describe("limits and cleanup", () => {
  it("allows a few pictures an hour per person, then says when to come back", async () => {
    const { portraits, characterId, r } = await setup({ maxPerHour: 2 });
    expect((await portraits.fromDescription("u-alice", characterId, "ink", "")).kind).toBe("ok");
    expect((await portraits.fromDescription("u-alice", characterId, "ink", "")).kind).toBe("ok");
    const third = await portraits.fromDescription("u-alice", characterId, "ink", "");
    expect(third).toMatchObject({ kind: "refused", reason: "rateLimited" });
    r.clock.advance(61 * 60 * 1000);
    expect((await portraits.fromDescription("u-alice", characterId, "ink", "")).kind).toBe("ok");
  });

  it("removes the portrait, and everything with a deleted character", async () => {
    const { portraits, store, characterId } = await setup();
    await portraits.fromDescription("u-alice", characterId, "ink", "");
    await portraits.accept("u-alice", characterId);
    await portraits.remove("u-alice", characterId);
    expect(await portraits.current("u-alice", characterId)).toBeUndefined();
    await portraits.fromDescription("u-alice", characterId, "ink", "");
    await portraits.forget(characterId);
    expect(store.images.size).toBe(0);
  });
});
