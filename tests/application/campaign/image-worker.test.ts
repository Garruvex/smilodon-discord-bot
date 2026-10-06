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
  public removeAll(key: CampaignKey): Promise<void> {
    for (const name of [...this.kept.keys()]) if (name.startsWith(`${key.campaignId}:`)) this.kept.delete(name);
    return Promise.resolve();
  }
}

async function table(): Promise<{ r: Rig; key: CampaignKey; painter: Painter; posted: { channelId: string; caption: string }[]; worker: ImageWorker; failPost: { on: boolean }; shelf: Shelf; clock: { now: number } }> {
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
  await r.store.transaction(async (tx) => {
    const stored = await tx.loadCampaign(key);
    if (stored === undefined) throw new Error("campaign");
    await tx.saveCampaign(key, { ...stored.state, sceneId: chapel }, stored.revision);
  });
  const painter = new Painter();
  const posted: { channelId: string; caption: string }[] = [];
  const failPost = { on: false };
  const shelf = new Shelf();
  // The tests enqueue pictures at instant 1; the clock starts there, so a picture is still inside its wait for narration.
  const clock = { now: 1 };
  const worker = new ImageWorker({
    now: (): number => clock.now,
    unitOfWork: r.store,
    adventures: r.adventures,
    generator: painter,
    sink: { post: (channelId, _image, caption): Promise<void> => (failPost.on ? Promise.reject(new Error("no permission")) : (posted.push({ channelId, caption }), Promise.resolve())) },
    assets: shelf,
  });
  return { r, key, painter, posted, worker, failPost, shelf, clock };
}

const ask = (t: Awaited<ReturnType<typeof table>>, sceneId: string, id = sceneId, roundNumber = 0): Promise<void> =>
  t.r.store.transaction((tx) => tx.enqueue(t.key, `img-${id}`, { kind: "sceneImage", sceneId, roundNumber }, 1));
const recordOf = async (t: Awaited<ReturnType<typeof table>>): Promise<NonNullable<Awaited<ReturnType<Rig["service"]["get"]>>>["record"]> => {
  const stored = await t.r.service.get(t.key);
  if (stored === undefined) throw new Error("record");
  return stored.record;
};

describe("scene pictures", () => {
  it("bounds automatic moments per scene while allowing manual moments and a new scene", async () => {
    const t = await table();
    const moments = [
      { round: 1, scene: chapel, auto: true },
      { round: 5, scene: chapel, auto: true },
      { round: 9, scene: chapel, auto: true },
      { round: 13, scene: chapel, auto: false },
      { round: 17, scene: "scene:old-watchtower", auto: true },
    ];
    for (const moment of moments) {
      await t.r.store.transaction(async (tx) => {
        await tx.appendEvents(t.key, [{ campaignId: t.key.campaignId, causationId: `moment-${moment.round}`, commandKind: "pass", actor: { kind: "system" }, rulesRevision: "test", recordedAt: 1, event: { kind: "narrationRecorded", roundNumber: moment.round, text: "The heroes discover a remarkable sight." } }]);
        await tx.enqueue(t.key, `moment-${moment.round}`, { kind: "momentImage", roundNumber: moment.round, auto: moment.auto, snapshot: { sceneId: moment.scene, world: { day: 1, time: "dusk" }, heroes: [] } }, 1);
      });
      expect((await t.worker.runOnce()).failed).toEqual([]);
    }
    expect(t.painter.prompts).toHaveLength(3);
    expect((await recordOf(t)).automaticMomentScenes).toEqual({ [chapel]: "moment:round-1", "scene:old-watchtower": "moment:round-17" });
    expect((await recordOf(t)).images?.["moment:round-9"]).toBe("skipped");
  });

  it("does not pay twice when worker passes overlap", async () => {
    const t = await table();
    await ask(t, chapel);
    await Promise.all([t.worker.runOnce(), t.worker.runOnce()]);
    expect(t.painter.prompts).toHaveLength(1);
    expect(t.posted).toHaveLength(1);
  });

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

  it("posts the saved picture again when the party arrives back in a scene, without painting twice", async () => {
    const t = await table();
    await ask(t, chapel);
    await t.worker.runOnce();
    expect(t.posted).toHaveLength(1);
    await ask(t, chapel, "return", 2);
    await t.worker.runOnce();
    expect(t.posted).toHaveLength(2);
    expect(t.painter.prompts).toHaveLength(1);
    expect((await recordOf(t)).images?.[chapel]).toBe("done");
  });

  it("keeps a late picture for its original scene without posting it into the current scene", async () => {
    const t = await table();
    await ask(t, "scene:old-watchtower");
    await t.worker.runOnce();
    expect(t.posted).toEqual([]);
    expect(t.painter.prompts[0]).toContain(starter.en.bible.scenes.find((scene) => scene.id === "scene:old-watchtower")?.title);
    expect((await recordOf(t)).images?.["scene:old-watchtower"]).toBe("held");
    expect(await t.shelf.load(t.key, "scene:old-watchtower")).toBeDefined();
    expect(await t.r.store.transaction((tx) => tx.pendingOutbox("sceneImage"))).toEqual([]);
  });

  it("waits for the round that moved the party to be told, then paints", async () => {
    const t = await table();
    const withRound = (lastRoundNumber: number, lastNarratedRound: number): Promise<void> =>
      t.r.store.transaction(async (tx) => {
        const stored = await tx.loadCampaign(t.key);
        if (stored === undefined) throw new Error("campaign");
        await tx.saveCampaign(t.key, { ...stored.state, lastRoundNumber, lastNarratedRound }, stored.revision);
      });
    await withRound(1, 0);
    await ask(t, chapel, chapel, 1);
    expect((await t.worker.runOnce()).processed).toBe(0);
    expect(t.painter.prompts).toHaveLength(0);
    // Still waiting, not failed or dropped.
    expect((await recordOf(t)).images?.[chapel]).toBeUndefined();
    expect(await t.r.store.transaction((tx) => tx.pendingOutbox("sceneImage"))).toHaveLength(1);

    await withRound(1, 1);
    expect((await t.worker.runOnce()).processed).toBe(1);
    expect(t.posted).toHaveLength(1);
  });

  it("paints from the scene's own description once the narrator has had its wait and still not told the round", async () => {
    const t = await table();
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("campaign");
      await tx.saveCampaign(t.key, { ...stored.state, lastRoundNumber: 1, lastNarratedRound: 0 }, stored.revision);
    });
    await ask(t, chapel, chapel, 1);
    expect((await t.worker.runOnce()).processed).toBe(0);
    t.clock.now = 1 + 121_000;
    expect((await t.worker.runOnce()).processed).toBe(1);
    expect(t.posted).toHaveLength(1);
    expect((await recordOf(t)).images?.[chapel]).toBe("done");
  });

  it("keeps the picture without posting if the party moves while generation is running", async () => {
    const t = await table();
    const generate = t.painter.generate.bind(t.painter);
    t.painter.generate = async (request): Promise<GeneratedImage> => {
      await t.r.store.transaction(async (tx) => {
        const stored = await tx.loadCampaign(t.key);
        if (stored === undefined) throw new Error("campaign");
        await tx.saveCampaign(t.key, { ...stored.state, sceneId: "scene:old-watchtower" }, stored.revision);
      });
      return generate(request);
    };
    await ask(t, chapel);
    expect((await t.worker.runOnce()).failed).toEqual([]);
    expect(t.painter.prompts).toHaveLength(1);
    expect(t.posted).toEqual([]);
    expect((await recordOf(t)).images?.[chapel]).toBe("held");
    expect(await t.shelf.load(t.key, chapel)).toBeDefined();
  });

  it("paints the scene the organizer asks for even if it has no picture yet, and again if it has one", async () => {
    const t = await table();
    const redo = (id: string): Promise<void> => t.r.store.transaction((tx) => tx.enqueue(t.key, id, { kind: "redoImage", subject: chapel }, 1));
    await redo("r1");
    await t.worker.runOnce();
    expect(t.painter.prompts).toHaveLength(1);
    await redo("r2");
    await t.worker.runOnce();
    expect(t.painter.prompts).toHaveLength(2);
    expect(t.posted).toHaveLength(2);
  });

  it("paints the moment that was asked for: its light, its place and its party, even after the story has moved on", async () => {
    const t = await table();
    const before = await t.r.store.transaction((tx) => tx.loadCampaign(t.key));
    if (before === undefined) throw new Error("campaign");
    const ids = Object.keys(before.state.characters);
    const first = before.state.characters[ids[0] ?? ""];
    if (first === undefined) throw new Error("hero");
    // The picture is asked for at dusk in the chapel, with one hero at level 1 carrying a mace ...
    const snapshot = { sceneId: chapel, world: { day: 2, time: "dusk", weather: "rain" }, heroes: [{ id: first.id, level: 1, equipment: ["item:mace"] }] };
    await t.r.store.transaction((tx) => tx.enqueue(t.key, "img-dusk", { kind: "sceneImage", sceneId: chapel, roundNumber: 0, snapshot }, 1));
    // ... and by the time the painter gets to it, it is dawn in another place and the hero has a different weapon.
    await t.r.store.transaction((tx) => tx.saveCampaign(t.key, { ...before.state, sceneId: "scene:old-watchtower", world: { day: 3, time: "dawn" }, characters: { ...before.state.characters, [first.id]: { ...first, level: 4, equipment: ["item:greataxe"] } } }, before.revision));
    await t.worker.runOnce();
    const prompt = t.painter.prompts[0] ?? "";
    expect(prompt).toContain("dusk, rain");
    expect(prompt).not.toContain("dawn");
    expect(prompt).toContain(`${first.name}, a level 1`);
    expect(prompt).toContain("mace");
    expect(prompt).not.toContain("greataxe");
    // Only the heroes who were there.
    for (const other of ids.slice(1)) expect(prompt).not.toContain(before.state.characters[other]?.name ?? "\u0000");
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
    expect((await recordOf(t)).images).toEqual({ [chapel]: "done", "scene:old-watchtower": "held" });
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
    expect(await t.shelf.load(t.key, chapel)).toBeDefined();
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

  it("does not post an old scene's saved picture when a failed delivery retries after a move", async () => {
    const t = await table();
    t.failPost.on = true;
    await ask(t, chapel);
    expect((await t.worker.runOnce()).failed).toHaveLength(1);
    expect((await recordOf(t)).images?.[chapel]).toBe("made");
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(t.key);
      if (stored === undefined) throw new Error("campaign");
      await tx.saveCampaign(t.key, { ...stored.state, sceneId: "scene:old-watchtower" }, stored.revision);
    });
    t.failPost.on = false;
    expect((await t.worker.runOnce()).failed).toEqual([]);
    expect(t.posted).toEqual([]);
    expect(t.painter.prompts).toHaveLength(1);
    expect((await recordOf(t)).images?.[chapel]).toBe("held");
    expect(await t.shelf.load(t.key, chapel)).toBeDefined();
    expect(await t.r.store.transaction((tx) => tx.pendingOutbox("sceneImage"))).toEqual([]);
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
    await t.r.store.transaction(async (tx) => {
      const stored = await tx.loadCampaign(second);
      if (stored === undefined) throw new Error("campaign");
      await tx.saveCampaign(second, { ...stored.state, sceneId: chapel }, stored.revision);
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
    await t.r.store.transaction((tx) => tx.enqueue(second, "img-second", { kind: "sceneImage", sceneId: chapel, roundNumber: 0 }, 1));
    await t.worker.runOnce();
    expect(peak).toBe(2);
    // Each campaign posts its current chapel; the old watchtower is generated and cached.
    expect(t.painter.prompts).toHaveLength(3);
    expect(t.posted.filter((post) => post.channelId === "chan-adventure")).toHaveLength(1);
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
    expect(prompt).toMatch(/Character identity: .*adventurer/);
    expect(prompt).toContain("Carried gear:");
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
