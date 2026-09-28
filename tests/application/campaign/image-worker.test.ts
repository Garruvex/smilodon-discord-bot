import { describe, expect, it } from "vitest";

import type { GeneratedImage, ImageAssetStore, ImageGenerator } from "../../../src/application/campaign/ports/image-ports.js";
import { ImageWorker } from "../../../src/application/campaign/workers/image-worker.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { starterAdventureId } from "../../../src/infrastructure/campaign/starter-adventures.js";
import { guildId, rig, startedCampaign, starter, tellOpening, type Rig } from "./campaign-rig.js";

const chapel = "scene:ruined-chapel";

class Painter implements ImageGenerator {
  public readonly prompts: string[] = [];
  public fail = 0;
  public size = 1_000;
  public generate(request: { prompt: string }): Promise<GeneratedImage> {
    this.prompts.push(request.prompt);
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

async function table(budget = 3): Promise<{ r: Rig; key: CampaignKey; painter: Painter; posted: { channelId: string; caption: string }[]; worker: ImageWorker; failPost: { on: boolean }; shelf: Shelf }> {
  const r = rig();
  const key = await startedCampaign(r);
  // The party's own portraits are asked for at the opening; these tests are about the rest.
  await r.store.transaction(async (tx) => {
    for (const item of await tx.pendingOutbox("heroImage")) await tx.completeOutbox(item.id);
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
    budgetPerCampaign: budget,
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
    expect(record.imageBudget).toEqual({ limit: 3, used: 1 });

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

  it("stops at the campaign's budget without failing anything", async () => {
    const t = await table(1);
    await ask(t, chapel);
    await ask(t, "scene:old-watchtower");
    expect((await t.worker.runOnce()).failed).toEqual([]);
    expect(t.painter.prompts).toHaveLength(1);
    expect((await recordOf(t)).images).toEqual({ [chapel]: "done", "scene:old-watchtower": "skipped" });
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
    expect((await recordOf(t)).imageBudget ?? { used: 0 }).toMatchObject({ used: 0 });
    // Nothing is left waiting, and the game itself is untouched.
    expect(await t.r.store.transaction((tx) => tx.pendingOutbox("sceneImage"))).toEqual([]);
    expect((await t.r.store.transaction((tx) => tx.loadCampaign(t.key)))?.state.status).toBe("active");
  });

  it("does not bill twice when only the posting failed, and the retry posts the saved picture", async () => {
    const t = await table();
    t.failPost.on = true;
    await ask(t, chapel);
    await t.worker.runOnce();
    expect((await recordOf(t)).imageBudget).toEqual({ limit: 3, used: 1 });
    expect((await recordOf(t)).images).toEqual({ [chapel]: "made" });
    expect(t.shelf.kept.size).toBe(1);
    // Discord works again: the retry delivers the same picture without painting.
    t.failPost.on = false;
    expect((await t.worker.runOnce()).processed).toBe(1);
    expect(t.posted).toHaveLength(1);
    expect(t.painter.prompts).toHaveLength(1);
    expect((await recordOf(t)).images).toEqual({ [chapel]: "done" });
    expect((await recordOf(t)).imageBudget).toEqual({ limit: 3, used: 1 });
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
      for (const item of await tx.pendingOutbox("heroImage")) await tx.completeOutbox(item.id);
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
