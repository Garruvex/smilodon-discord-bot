import { findScene, type AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { EngineRequest } from "../../../domain/campaign/engine/engine-request.js";
import type { CampaignRecord } from "../ports/campaign-record.js";
import { RevisionConflictError, type CampaignKey, type CampaignUnitOfWork, type OutboxItem } from "../ports/campaign-store.js";
import type { AdventureLibrary } from "../ports/adventure-library.js";
import type { ImageAssetStore, ImageGenerator, SceneImageSink } from "../ports/image-ports.js";
import type { WorkerRunResult } from "./roll-worker.js";

export interface ImageWorkerOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly adventures: AdventureLibrary;
  readonly generator: ImageGenerator;
  readonly sink: SceneImageSink;
  // A monster's English name for its portrait prompt, and its name in the game's language for the caption.
  readonly monsterName?: (monsterId: string, language: "en" | "zh-TW") => string | undefined;
  // Where a made picture waits until it is posted.
  readonly assets: ImageAssetStore;
  // Campaigns painting at the same time (one campaign's pictures never overlap).
  readonly concurrency?: number;
  // Pictures one campaign may have made in total.
  readonly budgetPerCampaign: number;
  // Refused above this many bytes, whatever the provider sent.
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  // A picture is tried this many times, then it goes without.
  readonly maxAttempts?: number;
}

export const sceneImageStyle = "A painterly fantasy illustration, atmospheric, no text, no lettering, no watermark.";
const defaultMaxBytes = 8 * 1024 * 1024;
// How much of a told round goes into a moment's prompt.
const momentTextLimit = 700;

type PictureRequest = Extract<EngineRequest, { kind: "sceneImage" | "monsterImage" | "momentImage" }>;

// What a picture is of, and the key it is recorded under on the campaign.
// A scene, a kind of monster (or a named NPC), or one told round each get one picture.
export function pictureSubject(request: PictureRequest): string {
  if (request.kind === "sceneImage") return request.sceneId;
  if (request.kind === "monsterImage") return request.npcId ?? request.monsterId;
  return `moment:round-${request.roundNumber}`;
}

const isPicture = (request: EngineRequest): request is PictureRequest => request.kind === "sceneImage" || request.kind === "monsterImage" || request.kind === "momentImage";

// Makes pictures as background jobs (plan §6, Adventures and images): one per
// scene the party enters, one per kind of monster it meets, and one for a
// moment the organizer asks for. Text play never waits for them: a failure or an
// empty budget only means there is no picture, and a picture that arrives late
// is posted for what it was made for. Every prompt is built from text the table
// has already been shown (a scene's public description, a monster's name and its
// NPC's public description, a round's told narration), so nothing the DM keeps
// secret can reach an image.
export class ImageWorker {
  public constructor(private readonly options: ImageWorkerOptions) {}

  // Campaigns run side by side, a few at a time; one campaign's pictures run in
  // order, so its budget is counted correctly and a repeat request finds the
  // picture the first one made.
  public async runOnce(): Promise<WorkerRunResult> {
    const items = (
      await this.options.unitOfWork.transaction(async (tx) => [...(await tx.pendingOutbox("sceneImage")), ...(await tx.pendingOutbox("monsterImage")), ...(await tx.pendingOutbox("momentImage"))])
    );
    const failed: { id: string; error: string }[] = [];
    let processed = 0;
    const lanes = new Map<string, OutboxItem[]>();
    for (const item of items) {
      const lane = `${item.key.guildId}:${item.key.campaignId}`;
      lanes.set(lane, [...(lanes.get(lane) ?? []), item]);
    }
    const queue = [...lanes.values()];
    const work = async (): Promise<void> => {
      for (let lane = queue.shift(); lane !== undefined; lane = queue.shift()) {
        for (const item of lane) {
          try {
            await this.process(item);
            await this.options.unitOfWork.transaction((tx) => tx.completeOutbox(item.id));
            processed += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failed.push({ id: item.id, error: message });
            await this.options.unitOfWork.transaction((tx) => tx.failOutboxAttempt(item.id, message, this.options.maxAttempts ?? 2));
            // Out of attempts: it is marked as gone without, so nothing waits on it.
            if (item.attempts + 1 >= (this.options.maxAttempts ?? 2) && isPicture(item.request)) {
              const subject = pictureSubject(item.request);
              await this.mark(item.key, subject, "failed");
              await this.options.assets.remove(item.key, subject).catch(() => undefined);
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.options.concurrency ?? 2, queue.length)) }, work));
    return { processed, failed };
  }

  private async process(item: OutboxItem): Promise<void> {
    const request = item.request;
    if (!isPicture(request)) return;
    const { unitOfWork, adventures, generator, sink, assets } = this.options;
    const subject = pictureSubject(request);
    const loaded = await unitOfWork.transaction(async (tx) => ({ stored: await tx.loadRecord(item.key), campaign: await tx.loadCampaign(item.key) }));
    if (loaded.stored === undefined || loaded.campaign === undefined) return;
    const { record } = loaded.stored;
    const existing = record.images?.[subject];
    // A subject keeps the picture it has, and a finished game makes no more.
    if (record.lifecycle === "archived") return;
    const channelId = record.channels.adventureChannelId;
    const bible = adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
    if (existing === "made") {
      // Made and paid for, but the post failed: post the saved picture; never paint again.
      const saved = await assets.load(item.key, subject);
      const found = bible === undefined ? undefined : await this.describe(request, item.key, record, bible);
      if (saved === undefined || found === undefined || channelId === null) return void (await this.mark(item.key, subject, "failed"));
      await sink.post(channelId, saved, found.caption);
      await this.mark(item.key, subject, "done");
      await assets.remove(item.key, subject).catch(() => undefined);
      return;
    }
    if (existing !== undefined) return;
    const budget = record.imageBudget ?? { limit: this.options.budgetPerCampaign, used: 0 };
    if (budget.used >= budget.limit) return void (await this.mark(item.key, subject, "skipped"));
    const described = bible === undefined ? undefined : await this.describe(request, item.key, record, bible);
    if (described === undefined || channelId === null) return void (await this.mark(item.key, subject, "skipped"));

    const image = await generator.generate({ prompt: described.prompt, timeoutMs: this.options.timeoutMs ?? 90_000 });
    if (image.bytes.byteLength > (this.options.maxBytes ?? defaultMaxBytes)) throw new Error("The picture is larger than the limit.");
    // Kept before it is counted, and counted when made, not when posted: a failed
    // post is retried from the saved picture without a second bill.
    await assets.save(item.key, subject, image);
    await this.mark(item.key, subject, "made", true);
    await sink.post(channelId, image, described.caption);
    await this.mark(item.key, subject, "done");
    await assets.remove(item.key, subject).catch(() => undefined);
  }

  // The prompt and caption for a picture, from public text only; undefined when what it is of is gone.
  private async describe(request: PictureRequest, key: CampaignKey, record: CampaignRecord, bible: AdventureBible): Promise<{ readonly prompt: string; readonly caption: string } | undefined> {
    const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();
    if (request.kind === "sceneImage") {
      const scene = findScene(bible, request.sceneId);
      return scene === undefined ? undefined : { prompt: `${scene.title}. ${collapse(scene.publicDescription)} ${sceneImageStyle}`, caption: scene.title };
    }
    if (request.kind === "monsterImage") {
      const name = this.options.monsterName?.(request.monsterId, "en") ?? request.monsterId.replace(/^monster:/, "").replace(/-/g, " ");
      const shown = this.options.monsterName?.(request.monsterId, record.language) ?? name;
      const npc = request.npcId === null ? undefined : bible.npcs.find((candidate) => candidate.id === request.npcId);
      const who = npc === undefined ? `a ${name}` : `${npc.name}, ${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
      return { prompt: `A fantasy character portrait of ${who}${npc === undefined ? "" : `. ${collapse(npc.publicDescription)}`}. ${sceneImageStyle}`, caption: npc?.name ?? shown };
    }
    const events = await this.options.unitOfWork.transaction((tx) => tx.readEvents(key));
    const told = events.map((envelope) => envelope.event).findLast((event) => event.kind === "narrationRecorded" && event.roundNumber === request.roundNumber);
    if (told?.kind !== "narrationRecorded") return undefined;
    const state = await this.options.unitOfWork.transaction((tx) => tx.loadCampaign(key));
    const scene = findScene(bible, state?.state.sceneId ?? null);
    return { prompt: `An illustration of this moment from a fantasy adventure: ${collapse(told.text).slice(0, momentTextLimit)} ${sceneImageStyle}`, caption: scene?.title ?? record.name };
  }

  // Records what became of a picture on the campaign record.
  private async mark(key: CampaignKey, subject: string, status: "made" | "done" | "skipped" | "failed", spend = false): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.options.unitOfWork.transaction(async (tx) => {
          const stored = await tx.loadRecord(key);
          if (stored === undefined) return;
          const record: CampaignRecord = stored.record;
          const budget = record.imageBudget ?? { limit: this.options.budgetPerCampaign, used: 0 };
          await tx.saveRecord({ ...record, images: { ...(record.images ?? {}), [subject]: status }, imageBudget: spend ? { ...budget, used: budget.used + 1 } : budget }, stored.revision);
        });
        return;
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error;
      }
    }
  }
}
