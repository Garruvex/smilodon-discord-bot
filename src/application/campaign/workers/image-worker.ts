import { findScene } from "../../../domain/campaign/adventure/adventure-bible.js";
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
  // Where a made picture waits until it is posted.
  readonly assets: ImageAssetStore;
  // Campaigns painting at the same time (one campaign's pictures never overlap).
  readonly concurrency?: number;
  // Pictures one campaign may have made in total.
  readonly budgetPerCampaign: number;
  // Refused above this many bytes, whatever the provider sent.
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  // A picture is tried this many times, then the scene goes without.
  readonly maxAttempts?: number;
}

export const sceneImageStyle = "A painterly fantasy illustration, atmospheric, no text, no lettering, no watermark.";
const defaultMaxBytes = 8 * 1024 * 1024;

// Makes one picture per scene as a background job (plan §6, Adventures and
// images). Text play never waits for it: the job runs after the scene's
// narration, a failure or an empty budget only means the scene has no picture,
// and a picture that arrives late is posted for the scene it was made for. The
// prompt is built from the scene's public description alone, so nothing the
// DM keeps secret can reach an image.
export class ImageWorker {
  public constructor(private readonly options: ImageWorkerOptions) {}

  // Campaigns run side by side, a few at a time; one campaign's pictures run in
  // order, so its budget is counted correctly and a repeat request finds the
  // picture the first one made.
  public async runOnce(): Promise<WorkerRunResult> {
    const items = await this.options.unitOfWork.transaction((tx) => tx.pendingOutbox("sceneImage"));
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
            // Out of attempts: the scene is marked as gone without, so nothing waits on it.
            if (item.attempts + 1 >= (this.options.maxAttempts ?? 2) && item.request.kind === "sceneImage") {
              await this.mark(item.key, item.request.sceneId, "failed");
              await this.options.assets.remove(item.key, item.request.sceneId).catch(() => undefined);
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
    if (request.kind !== "sceneImage") return;
    const { unitOfWork, adventures, generator, sink, assets } = this.options;
    const loaded = await unitOfWork.transaction(async (tx) => ({ stored: await tx.loadRecord(item.key), campaign: await tx.loadCampaign(item.key) }));
    if (loaded.stored === undefined || loaded.campaign === undefined) return;
    const { record } = loaded.stored;
    const existing = record.images?.[request.sceneId];
    // A scene keeps the picture it has, and a finished game makes no more.
    if (record.lifecycle === "archived") return;
    const channel = record.channels.adventureChannelId;
    if (existing === "made") {
      // Made and paid for, but the post failed: post the saved picture; never paint again.
      const saved = await assets.load(item.key, request.sceneId);
      const scene = adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
      const found = scene === undefined ? undefined : findScene(scene, request.sceneId);
      if (saved === undefined || found === undefined || channel === null) return void (await this.mark(item.key, request.sceneId, "failed"));
      await sink.post(channel, saved, found.title);
      await this.mark(item.key, request.sceneId, "done");
      await assets.remove(item.key, request.sceneId).catch(() => undefined);
      return;
    }
    if (existing !== undefined) return;
    const budget = record.imageBudget ?? { limit: this.options.budgetPerCampaign, used: 0 };
    if (budget.used >= budget.limit) return void (await this.mark(item.key, request.sceneId, "skipped"));
    const bible = adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
    const scene = bible === undefined ? undefined : findScene(bible, request.sceneId);
    const channelId = record.channels.adventureChannelId;
    if (scene === undefined || channelId === null) return void (await this.mark(item.key, request.sceneId, "skipped"));

    const prompt = `${scene.title}. ${scene.publicDescription.replace(/\s+/g, " ").trim()} ${sceneImageStyle}`;
    const image = await generator.generate({ prompt, timeoutMs: this.options.timeoutMs ?? 90_000 });
    if (image.bytes.byteLength > (this.options.maxBytes ?? defaultMaxBytes)) throw new Error("The picture is larger than the limit.");
    // Kept before it is counted, and counted when made, not when posted: a failed
    // post is retried from the saved picture without a second bill.
    await assets.save(item.key, request.sceneId, image);
    await this.mark(item.key, request.sceneId, "made", true);
    await sink.post(channelId, image, scene.title);
    await this.mark(item.key, request.sceneId, "done");
    await assets.remove(item.key, request.sceneId).catch(() => undefined);
  }

  // Records what became of a scene's picture on the campaign record.
  private async mark(key: CampaignKey, sceneId: string, status: "made" | "done" | "skipped" | "failed", spend = false): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.options.unitOfWork.transaction(async (tx) => {
          const stored = await tx.loadRecord(key);
          if (stored === undefined) return;
          const record: CampaignRecord = stored.record;
          const budget = record.imageBudget ?? { limit: this.options.budgetPerCampaign, used: 0 };
          await tx.saveRecord({ ...record, images: { ...(record.images ?? {}), [sceneId]: status }, imageBudget: spend ? { ...budget, used: budget.used + 1 } : budget }, stored.revision);
        });
        return;
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error;
      }
    }
  }
}
