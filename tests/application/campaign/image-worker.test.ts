import { describe, expect, it } from "vitest";

import type { GeneratedImage, ImageGenerator } from "../../../src/application/campaign/ports/image-ports.js";
import { ImageWorker } from "../../../src/application/campaign/workers/image-worker.js";
import type { CampaignKey } from "../../../src/application/campaign/ports/campaign-store.js";
import { rig, startedCampaign, starter, type Rig } from "./campaign-rig.js";

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

async function table(budget = 3): Promise<{ r: Rig; key: CampaignKey; painter: Painter; posted: { channelId: string; caption: string }[]; worker: ImageWorker; failPost: { on: boolean } }> {
  const r = rig();
  const key = await startedCampaign(r);
  await r.store.transaction(async (tx) => {
    const stored = await tx.loadRecord(key);
    if (stored === undefined) throw new Error("record");
    await tx.saveRecord({ ...stored.record, channels: { ...stored.record.channels, adventureChannelId: "chan-adventure" } }, stored.revision);
  });
  const painter = new Painter();
  const posted: { channelId: string; caption: string }[] = [];
  const failPost = { on: false };
  const worker = new ImageWorker({
    unitOfWork: r.store,
    adventures: r.adventures,
    generator: painter,
    sink: { post: (channelId, _image, caption): Promise<void> => (failPost.on ? Promise.reject(new Error("no permission")) : (posted.push({ channelId, caption }), Promise.resolve())) },
    budgetPerCampaign: budget,
  });
  return { r, key, painter, posted, worker, failPost };
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

  it("does not bill twice when only the posting failed", async () => {
    const t = await table();
    t.failPost.on = true;
    await ask(t, chapel);
    await t.worker.runOnce();
    expect((await recordOf(t)).imageBudget).toEqual({ limit: 3, used: 1 });
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
