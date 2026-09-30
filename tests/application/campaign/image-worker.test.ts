import { describe, expect, it } from "vitest";

import { ImageProviderError, type GeneratedImage, type ImageAspect, type ImageAssetStore, type ImageGenerator } from "../../../src/application/campaign/ports/image-ports.js";
import { ImageWorker } from "../../../src/application/campaign/workers/image-worker.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { starterAdventureId } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { guildId, rig, startedCampaign, starter, tellOpening, type Rig } from "./campaign-rig.js";

const chapel = "scene:ruined-chapel";

class Painter implements ImageGenerator {
  public readonly prompts: string[] = [];
  public readonly references: (readonly { readonly name: string; readonly image: GeneratedImage }[] | undefined)[] = [];
  public readonly aspects: (ImageAspect | undefined)[] = [];
  public fail = 0;
  // The provider's own rules said no: trying again would be refused the same way.
  public refuse = false;
  public size = 1_000;
  public generate(request: { prompt: string; aspect?: ImageAspect; references?: readonly { readonly name: string; readonly image: GeneratedImage }[] }): Promise<GeneratedImage> {
    this.prompts.push(request.prompt);
    this.references.push(request.references);
    this.aspects.push(request.aspect);
    if (this.refuse) return Promise.reject(new ImageProviderError("The image provider answered 400: moderation_blocked.", false));
    if (this.fail > 0) {
      this.fail -= 1;
      return Promise.reject(new Error("The provider is busy."));
    }
    return Promise.resolve({ bytes: Buffer.alloc(this.size), mediaType: "image/png" });
  }
}

class Shelf implements ImageAssetStore {
  public readonly kept = new Map<string, GeneratedImage>();
  public save(key: CampaignKey, sceneId: string, image: GeneratedImage): Promise<void> {
    this.kept.set(`${key.campaignId}:${sceneId}`, image);
    return Promise.resolve();
  }
  public load(key: CampaignKey, sceneId: string): Promise<GeneratedImage | undefined> {
    return Promise.resolve(this.kept.get(`${key.campaignId}:${sceneId}`));
  }
  public remove(key: CampaignKey, sceneId: string): Promise<void> {
    this.kept.delete(`${key.campaignId}:${sceneId}`);
    return Promise.resolve();
  }
}

async function table(): Promise<{ r: Rig; key: CampaignKey; painter: Painter; posted: { channelId: string; caption: string }[]; worker: ImageWorker; failPost: { on: boolean }; shelf: Shelf }> {
  const r = rig();
  const key = await startedCampaign(r);
  // The opening scene is illustrated separately; these tests are about the rest.
  await r.store.transaction(async (tx) => {
    for (const item of await tx.pendingOutbox("sceneImage")) await tx.completeOutbox(item.id);
  });
  await r.store.transaction(async (tx) => {
    const stored = await tx.loadRecord(key);
    if (stored === undefined) throw new Error("record");
    await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, adventurePostId: "chan-adventure" } }, stored.revision);
  });
  const painter = new Painter();
  const posted: { channelId: string; caption: string }[] = [];
  const failPost = { on: false };
  const shelf = new Shelf();
  const worker = new ImageWorker({
    unitOfWork: r.store,
    adventures: r.adventures,
    generator: painter,
    sink: { post: (channelId, _image, caption): Promise<void> => (failPost.on ? Promise.reject(new Error("no permission")) : (posted.push({ channelId, caption }), Promise.resolve())) },
    assets: shelf,
  });
  return { r, key, painter, posted, worker, failPost, shelf };
}

const ask = (t: Awaited<ReturnType<typeof table>>, sceneId: string, id = sceneId): Promise<void> =>
  t.r.store.transaction((tx) => tx.enqueue(t.key, `img-${id}`, { kind: "sceneImage", sceneId, roundNumber: 1 }, 1));
const recordOf = async (t: Awaited<ReturnType<typeof table>>): Promise<NonNullable<Awaited<ReturnType<Rig["service"]["get"]>>>["record"]> => {
  const stored = await t.r.service.get(t.key);
  if (stored === undefined) throw new Error("record");
  return stored.record;
};

describe("scene pictures", () => {
  it("paints a scene once from its public description alone, and posts it with the scene's title", async () => {
    const t = await table();
    await ask(t, chapel);
    expect((await t.worker.runOnce()).processed).toBe(1);
    const scene = starter.en.bible.scenes.find((candidate) => candidate.id === chapel);
    expect(t.posted).toEqual([{ channelId: "chan-adventure", caption: scene?.title }]);
    // The prompt is the public text: nothing the DM keeps to themselves.
    expect(t.painter.prompts[0]).toContain(scene?.title);
    expect(t.painter.prompts[0]).not.toContain(scene?.dmNotes.slice(0, 40));
    for (const npc of starter.en.bible.npcs) expect(t.painter.prompts[0]).not.toContain(npc.secret.slice(0, 40));
    const record = await recordOf(t);
    expect(record.images).toEqual({ [chapel]: "done" });
    expect(record.imageBudget).toBeUndefined();

    // Asked again, the scene keeps the picture it has.
    await ask(t, chapel, "again");
    await t.worker.runOnce();
    expect(t.painter.prompts).toHaveLength(1);
  });

  it("attaches a late picture to the scene it was made for, not the one the party is in now", async () => {
    const t = await table();
    await ask(t, "scene:old-watchtower");
    await t.worker.runOnce();
    expect(t.posted[0]?.caption).toBe(starter.en.bible.scenes.find((scene) => scene.id === "scene:old-watchtower")?.title);
  });

  it("paints each distinct scene without a campaign image cap", async () => {
    const t = await table();
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadRecord(t.key);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, imageBudget: { limit: 1, used: 1 } }, stored.revision);
    });
    await ask(t, chapel);
    await ask(t, "scene:old-watchtower");
    expect((await t.worker.runOnce()).failed).toEqual([]);
    expect(t.painter.prompts).toHaveLength(2);
    expect((await recordOf(t)).images).toEqual({ [chapel]: "done", "scene:old-watchtower": "done" });
  });

  it("leaves text play alone when the model fails: tries twice, then the scene goes without", async () => {
    const t = await table();
    t.painter.fail = 5;
    await ask(t, chapel);
    expect((await t.worker.runOnce()).failed).toHaveLength(1);
    expect((await recordOf(t)).images).toBeUndefined();
    expect((await t.worker.runOnce()).failed).toHaveLength(1);
    expect((await recordOf(t)).images).toEqual({ [chapel]: "failed" });
    expect(t.posted).toEqual([]);
    expect((await recordOf(t)).imageBudget).toBeUndefined();
    // Nothing is left waiting, and the game itself is untouched.
    expect(await t.r.store.transaction((tx) => tx.pendingOutbox("sceneImage"))).toEqual([]);
    expect((await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.status).toBe("active");
  });

  it("does not generate twice when only the posting failed, and the retry posts the saved picture", async () => {
    const t = await table();
    t.failPost.on = true;
    await ask(t, chapel);
    await t.worker.runOnce();
    expect((await recordOf(t)).imageBudget).toBeUndefined();
    expect((await recordOf(t)).images).toEqual({ [chapel]: "made" });
    expect(t.shelf.kept.size).toBe(1);
    // Discord works again: the retry delivers the same picture without painting.
    t.failPost.on = false;
    expect((await t.worker.runOnce()).processed).toBe(1);
    expect(t.posted).toHaveLength(1);
    expect(t.painter.prompts).toHaveLength(1);
    expect((await recordOf(t)).images).toEqual({ [chapel]: "done" });
    expect((await recordOf(t)).imageBudget).toBeUndefined();
    expect(t.shelf.kept.size).toBe(0);
  });

  it("gives the scene up, and drops the saved picture, when every post fails", async () => {
    const t = await table();
    t.failPost.on = true;
    await ask(t, chapel);
    await t.worker.runOnce();
    await t.worker.runOnce();
    expect((await recordOf(t)).images).toEqual({ [chapel]: "failed" });
    expect(t.shelf.kept.size).toBe(0);
    expect(t.painter.prompts).toHaveLength(1);
  });

  it("paints different campaigns side by side, and one campaign's scenes in order", async () => {
    const t = await table();
    const created = await t.r.service.create({ guildId, organizerId: "u-two", name: "Other Ruins", language: "en", adventureId: starterAdventureId, pacing: { preset: "live" } });
    if (created.kind !== "ok") throw new Error("create");
    const second = created.value.key;
    await t.r.service.join(second, "u-two");
    await t.r.service.chooseHero(second, "u-two", starter.en.heroes[0]?.id ?? "");
    await t.r.service.start(second, "u-two");
    await tellOpening(t.r, second);
    await t.r.store.transaction(async (tx) => {
      for (const item of await tx.pendingOutbox("sceneImage")) await tx.completeOutbox(item.id);
      const stored = await tx.loadRecord(second);
      if (stored === undefined) throw new Error("record");
      await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, adventurePostId: "chan-two" } }, stored.revision);
    });
    let running = 0;
    let peak = 0;
    const generate = t.painter.generate.bind(t.painter);
    t.painter.generate = async (request): Promise<GeneratedImage> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return generate(request);
    };
    await ask(t, chapel);
    await ask(t, chapel, "twice");
    await ask(t, "scene:old-watchtower");
    await t.r.store.transaction((tx) => tx.enqueue(second, "img-second", { kind: "sceneImage", sceneId: chapel, roundNumber: 1 }, 1));
    await t.worker.runOnce();
    expect(peak).toBe(2);
    // The first campaign: chapel once, then the watchtower. The second: its chapel.
    expect(t.painter.prompts).toHaveLength(3);
    expect(t.posted.filter((post) => post.channelId === "chan-adventure")).toHaveLength(2);
    expect(t.posted.filter((post) => post.channelId === "chan-two")).toHaveLength(1);
  });

  it("refuses a picture over the size limit, and paints nothing for a finished game", async () => {
    const t = await table();
    t.painter.size = 9 * 1024 * 1024;
    await ask(t, chapel);
    expect((await t.worker.runOnce()).failed[0]?.error).toBe("The picture is larger than the limit.");
    const finished = await table();
    await finished.r.service.end(finished.key);
    await ask(finished, chapel);
    await finished.worker.runOnce();
    expect(finished.painter.prompts).toEqual([]);
  });
});

describe("a hero from a saved character", () => {
  async function withOrigin(t: Awaited<ReturnType<typeof table>>): Promise<{ heroId: string; name: string }> {
    const stored = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    const sheet = Object.values(stored?.state.characters ?? {})[0];
    if (stored === undefined || sheet === undefined) throw new Error("hero");
    await t.r.store.transaction(async (tx) => {
      const latest = await tx.loadCampaign(t.key);
      if (latest === undefined) throw new Error("state");
      await tx.saveCampaign(t.key, { ...latest.state, characters: { ...latest.state.characters, [sheet.id]: { ...sheet, origin: { libraryCharacterId: "lc-wren", snapshotId: "ls-wren" } } } }, latest.revision);
    });
    return { heroId: sheet.id, name: sheet.name };
  }

  it("posts the player's saved portrait without generating a replacement", async () => {
    const t = await table();
    const { heroId, name } = await withOrigin(t);
    const worker = new ImageWorker({
      unitOfWork: t.r.store,
      adventures: t.r.adventures,
      generator: t.painter,
      sink: { post: (channelId, image, caption): Promise<void> => (t.posted.push({ channelId, caption: `${caption}:${image.bytes.toString()}` }), Promise.resolve()) },
      assets: t.shelf,
      portraits: { forGame: (id): Promise<GeneratedImage | undefined> => Promise.resolve(id === "lc-wren" ? { bytes: Buffer.from("own"), mediaType: "image/png" } : undefined) },
    });
    await t.r.store.transaction((tx) => tx.enqueue(t.key, "img-hero", { kind: "heroImage", characterId: heroId }, 1));
    expect((await worker.runOnce()).processed).toBe(1);
    expect(t.posted).toEqual([{ channelId: "chan-adventure", caption: `${name}:own` }]);
    expect(t.painter.prompts).toEqual([]);
    const record = await recordOf(t);
    expect(record.images).toEqual({ [`hero:${heroId}`]: "done" });
    expect(record.imageBudget).toBeUndefined();
  });

  it("uses the present hero's race, class and saved portrait when painting a scene", async () => {
    const t = await table();
    const { heroId, name } = await withOrigin(t);
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("state");
      const hero = stored.state.characters[heroId];
      if (hero === undefined) throw new Error("hero");
      await tx.saveCampaign(t.key, { ...stored.state, characters: { ...stored.state.characters, [heroId]: { ...hero, race: "race:hill-dwarf" } } }, stored.revision);
    });
    const portrait = { bytes: Buffer.from("portrait"), mediaType: "image/png" as const };
    const worker = new ImageWorker({
      unitOfWork: t.r.store,
      adventures: t.r.adventures,
      generator: t.painter,
      sink: { post: (): Promise<void> => Promise.resolve() },
      assets: t.shelf,
      portraits: { forGame: (): Promise<GeneratedImage> => Promise.resolve(portrait) },
    });
    await ask(t, chapel);
    await worker.runOnce();
    expect(t.painter.prompts[0]).toContain(`${name}, a level 1 hill dwarf fighter`);
    expect(t.painter.prompts[0]).toContain("carrying");
    expect(t.painter.prompts[0]).toContain("reference image 1");
    expect(t.painter.references[0]).toEqual([{ name, image: portrait }]);
  });

  it("is painted as before when its character has no portrait, and a redo paints again rather than reposting", async () => {
    const t = await table();
    const { heroId } = await withOrigin(t);
    let has = false;
    const worker = new ImageWorker({
      unitOfWork: t.r.store,
      adventures: t.r.adventures,
      generator: t.painter,
      sink: { post: (channelId, _image, caption): Promise<void> => (t.posted.push({ channelId, caption }), Promise.resolve()) },
      assets: t.shelf,
      portraits: { forGame: (): Promise<GeneratedImage | undefined> => Promise.resolve(has ? { bytes: Buffer.from("own"), mediaType: "image/png" } : undefined) },
    });
    await t.r.store.transaction((tx) => tx.enqueue(t.key, "img-hero", { kind: "heroImage", characterId: heroId }, 1));
    await worker.runOnce();
    expect(t.painter.prompts).toHaveLength(1);
    expect((await recordOf(t)).imageBudget).toBeUndefined();
    // Asked to paint it again after a portrait exists: the redo is a painting, not a repost.
    has = true;
    await t.r.store.transaction((tx) => tx.enqueue(t.key, "img-redo", { kind: "redoImage", subject: `hero:${heroId}` }, 1));
    await worker.runOnce();
    expect(t.painter.prompts).toHaveLength(2);
  });
});

describe("how a picture is asked for", () => {
  it("shapes a place wide and a face square", async () => {
    const t = await table();
    await ask(t, chapel);
    const heroId = Object.keys((await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.characters ?? {})[0] ?? "";
    await t.r.store.transaction((tx) => tx.enqueue(t.key, "img-hero", { kind: "heroImage", characterId: heroId }, 1));
    await t.worker.runOnce();
    expect([...t.painter.aspects].sort()).toEqual(["square", "wide"]);
  });

  it("describes a hero by the class on the sheet and the gear they carry", async () => {
    const t = await table();
    const state = (await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state;
    const sheet = Object.values(state?.characters ?? {})[0];
    if (sheet === undefined) throw new Error("hero");
    await t.r.store.transaction((tx) => tx.enqueue(t.key, "img-hero", { kind: "heroImage", characterId: sheet.id }, 1));
    await t.worker.runOnce();
    const prompt = t.painter.prompts[0] ?? "";
    expect(prompt).toContain(sheet.name);
    expect(prompt).toMatch(/Subject: .*adventurer/);
    expect(prompt).toContain("Carrying:");
    expect(prompt).toContain("No text");
  });

  it("does not ask again after a refusal, and the picture goes without at once", async () => {
    const t = await table();
    t.painter.refuse = true;
    await ask(t, chapel);
    expect((await t.worker.runOnce()).failed).toHaveLength(1);
    expect(t.painter.prompts).toHaveLength(1);
    expect((await recordOf(t)).images).toEqual({ [chapel]: "failed" });
    expect(await t.r.store.transaction((tx) => tx.pendingOutbox("sceneImage"))).toEqual([]);
    expect((await t.worker.runOnce()).processed).toBe(0);
    expect(t.painter.prompts).toHaveLength(1);
  });
});
