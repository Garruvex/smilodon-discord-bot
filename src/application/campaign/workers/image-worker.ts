import { findScene, type AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { EngineRequest, PictureSnapshot } from "../../../domain/campaign/engine/engine-request.js";
import type { CampaignRecord } from "../ports/campaign-record.js";
import { RevisionConflictError, type CampaignKey, type CampaignUnitOfWork, type OutboxItem } from "../ports/campaign-store.js";
import type { AdventureLibrary } from "../ports/adventure-library.js";
import { creaturePrompt, heroPrompt, momentPrompt, scenePrompt, type PictureBrief } from "../images/image-prompts.js";
import { ImageProviderError, type GeneratedImage, type ImageAssetStore, type ImageGenerator, type SceneImageSink } from "../ports/image-ports.js";
import type { WorkerRunResult } from "./roll-worker.js";

export interface ImageWorkerOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly adventures: AdventureLibrary;
  readonly generator: ImageGenerator;
  readonly sink: SceneImageSink;
  // A monster's English name for its portrait prompt, and its name in the game's language for the caption.
  readonly monsterName?: (monsterId: string, language: "en" | "zh-TW") => string | undefined;
  // A ready-made portrait for a monster, used when its painting fails.
  readonly fallback?: (monsterId: string) => Promise<GeneratedImage | undefined>;
  // Where a made picture waits until it is posted.
  readonly assets: ImageAssetStore;
  // The portrait a player gave a library character, also used as a scene reference.
  readonly portraits?: { forGame(libraryCharacterId: string): Promise<GeneratedImage | undefined> };
  // Campaigns painting at the same time (one campaign's pictures never overlap).
  readonly concurrency?: number;
  // Refused above this many bytes, whatever the provider sent.
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  // A picture is tried this many times, then it goes without.
  readonly maxAttempts?: number;
}

const defaultMaxBytes = 8 * 1024 * 1024;

type PictureRequest = Extract<EngineRequest, { kind: "sceneImage" | "monsterImage" | "momentImage" | "heroImage" | "redoImage" }>;
// The kinds a picture can be painted for; a redo names one of them by its subject.
type Painted = Exclude<PictureRequest, { kind: "redoImage" }>;
const pictureKinds = ["sceneImage", "monsterImage", "momentImage", "heroImage", "redoImage"] as const;
// An automatic moment picture waits until this many rounds after the last one.
const autoMomentGap = 3;

// What a picture is of, and the key it is recorded under on the campaign.
// A scene, a kind of monster (or a named NPC), or one told round each get one picture.
export function pictureSubject(request: PictureRequest): string {
  if (request.kind === "sceneImage") return request.sceneId;
  if (request.kind === "monsterImage") return request.npcId ?? request.monsterId;
  if (request.kind === "heroImage") return `hero:${request.characterId}`;
  if (request.kind === "redoImage") return request.subject;
  return `moment:round-${request.roundNumber}`;
}

const isPicture = (request: EngineRequest): request is PictureRequest => (pictureKinds as readonly string[]).includes(request.kind);

// A redo names its picture by subject; this finds what to paint again (undefined when it is gone).
function paintedFor(subject: string, bible: AdventureBible): Painted | undefined {
  const round = /^moment:round-(\d+)$/.exec(subject);
  if (round !== null) return { kind: "momentImage", roundNumber: Number(round[1]) };
  if (subject.startsWith("hero:")) return { kind: "heroImage", characterId: subject.slice("hero:".length) };
  if (findScene(bible, subject) !== undefined) return { kind: "sceneImage", sceneId: subject, roundNumber: 0 };
  if (subject.startsWith("monster:")) return { kind: "monsterImage", monsterId: subject, npcId: null };
  const fighter = bible.encounters.flatMap((encounter) => encounter.monsters).find((monster) => monster.npcId === subject);
  return fighter === undefined ? undefined : { kind: "monsterImage", monsterId: fighter.monsterId, npcId: subject };
}

// Makes pictures as background jobs (plan §6, Adventures and images): one per
// scene the party enters, one per kind of monster it meets, and one for a
// moment the organizer asks for. Text play never waits for them: a failure
// only means there is no picture, and a picture that arrives late
// is posted for what it was made for. Every prompt is built from text the table
// has already been shown (a scene's public description, a monster's name and its
// NPC's public description, a round's told narration), so nothing the DM keeps
// secret can reach an image.
export class ImageWorker {
  public constructor(private readonly options: ImageWorkerOptions) {}

  // Campaigns run side by side, a few at a time; one campaign's pictures run in
  // order, so a repeat request finds the picture the first one made.
  public async runOnce(): Promise<WorkerRunResult> {
    const items = (
      await this.options.unitOfWork.transaction(async (tx) => [...(await tx.pendingOutbox("sceneImage")), ...(await tx.pendingOutbox("monsterImage")), ...(await tx.pendingOutbox("heroImage")), ...(await tx.pendingOutbox("momentImage")), ...(await tx.pendingOutbox("redoImage"))])
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
            // A scene picture asked for by a round waits until that round has been told, so it lands after its narration.
            if ((await this.process(item)) === "later") continue;
            await this.options.unitOfWork.transaction((tx) => tx.completeOutbox(item.id));
            processed += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failed.push({ id: item.id, error: message });
            // A refusal would come back the same on a second try (and be billed again): it is the last attempt.
            const attempts = error instanceof ImageProviderError && !error.retryable ? 1 : (this.options.maxAttempts ?? 2);
            await this.options.unitOfWork.transaction((tx) => tx.failOutboxAttempt(item.id, message, attempts));
            // Out of attempts: it is marked as gone without, so nothing waits on it.
            if (item.attempts + 1 >= attempts && isPicture(item.request)) {
              const subject = pictureSubject(item.request);
              // A monster without a painting may still have a ready-made portrait.
              const ready = await this.postFallback(item, item.request).catch(() => false);
              if (!ready) await this.mark(item.key, subject, "failed");
              await this.options.assets.remove(item.key, subject).catch(() => undefined);
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.options.concurrency ?? 2, queue.length)) }, work));
    return { processed, failed };
  }

  private async process(item: OutboxItem): Promise<"later" | void> {
    const asked = item.request;
    if (!isPicture(asked)) return;
    const { unitOfWork, adventures, generator, sink, assets } = this.options;
    const subject = pictureSubject(asked);
    const loaded = await unitOfWork.transaction(async (tx) => ({ stored: await tx.loadRecord(item.key), campaign: await tx.loadCampaign(item.key) }));
    if (loaded.stored === undefined || loaded.campaign === undefined) return;
    const { state } = loaded.campaign;
    if (asked.kind === "sceneImage" && asked.roundNumber > 0 && state.lastRoundNumber === asked.roundNumber && state.lastNarratedRound < asked.roundNumber) return "later";
    const { record } = loaded.stored;
    const existing = record.images?.[subject];
    // A subject keeps the picture it has, and a finished game makes no more.
    if (record.lifecycle === "archived") return;
    const channelId = record.channels.adventurePostId;
    const bible = adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
    // A redo paints the subject again; anything else keeps the picture it has.
    const forced = asked.kind === "redoImage";
    const request = asked.kind === "redoImage" ? (bible === undefined ? undefined : paintedFor(asked.subject, bible)) : asked;
    // A redo of a scene that has no picture yet simply paints it: that is how the organizer asks for the scene they are in.
    if (request === undefined || (forced && existing === undefined && request.kind !== "sceneImage")) return;
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
    if (existing !== undefined && !forced) return;
    if (request.kind === "heroImage" && !forced && channelId !== null) {
      const own = await this.ownPortrait(item.key, request.characterId);
      if (own !== undefined) {
        await sink.post(channelId, own.image, own.name);
        await this.mark(item.key, subject, "done");
        return;
      }
    }
    // Avoid flooding the channel with closely spaced automatic roll pictures.
    if (request.kind === "momentImage" && request.auto === true) {
      const recent = Object.keys(record.images ?? {}).some((key) => {
        const round = /^moment:round-(\d+)$/.exec(key);
        return round !== null && Math.abs(Number(round[1]) - request.roundNumber) <= autoMomentGap && key !== subject;
      });
      if (recent) return void (await this.mark(item.key, subject, "skipped"));
    }
    const described = bible === undefined ? undefined : await this.describe(request, item.key, record, bible);
    if (described === undefined || channelId === null) return void (await this.mark(item.key, subject, "skipped"));

    const image = await generator.generate({ prompt: described.prompt, aspect: described.aspect, timeoutMs: this.options.timeoutMs ?? 90_000, ...(described.references === undefined ? {} : { references: described.references }) });
    if (image.bytes.byteLength > (this.options.maxBytes ?? defaultMaxBytes)) throw new Error("The picture is larger than the limit.");
    // Keep the generated picture before posting, so a failed post retries
    // the same image without paying the provider again.
    await assets.save(item.key, subject, image);
    await this.mark(item.key, subject, "made");
    await sink.post(channelId, image, described.caption);
    await this.mark(item.key, subject, "done");
    await assets.remove(item.key, subject).catch(() => undefined);
  }

  // The player's own portrait for a hero that came from their library, if they gave one.
  private async ownPortrait(key: CampaignKey, characterId: string): Promise<{ readonly image: GeneratedImage; readonly name: string } | undefined> {
    const { unitOfWork, portraits } = this.options;
    if (portraits === undefined) return undefined;
    const sheet = (await unitOfWork.transaction((tx) => tx.loadCampaign(key)))?.state.characters[characterId];
    if (sheet?.origin === undefined) return undefined;
    const image = await portraits.forGame(sheet.origin.libraryCharacterId);
    return image === undefined ? undefined : { image, name: sheet.name };
  }

  // A ready-made portrait for a monster picture that could not be painted.
  private async postFallback(item: OutboxItem, request: PictureRequest): Promise<boolean> {
    const { unitOfWork, adventures, sink, fallback } = this.options;
    const target = request.kind === "redoImage" ? undefined : request;
    if (fallback === undefined || target?.kind !== "monsterImage") return false;
    const loaded = await unitOfWork.transaction((tx) => tx.loadRecord(item.key));
    const channelId = loaded?.record.channels.adventurePostId ?? null;
    const bible = loaded === undefined ? undefined : adventures.find(loaded.record.adventure.adventureId, loaded.record.adventure.version, loaded.record.language);
    const image = await fallback(target.monsterId);
    if (loaded === undefined || bible === undefined || channelId === null || image === undefined) return false;
    const described = await this.describe(target, item.key, loaded.record, bible);
    if (described === undefined) return false;
    await sink.post(channelId, image, described.caption);
    await this.mark(item.key, pictureSubject(target), "done");
    return true;
  }

  // The prompt and caption for a picture, from public text only; undefined when what it is of is gone.
  private async describe(request: Painted, key: CampaignKey, record: CampaignRecord, bible: AdventureBible): Promise<(PictureBrief & { readonly caption: string; readonly references?: readonly { readonly name: string; readonly image: GeneratedImage }[] }) | undefined> {
    if (request.kind === "sceneImage") {
      const scene = findScene(bible, request.sceneId);
      if (scene === undefined) return undefined;
      // The opening has already been told when its image is queued. Use that
      // public narration to show the room as the players encountered it.
      const opening = request.roundNumber === 0 && request.sceneId === bible.startScene
        ? (await this.options.unitOfWork.transaction((tx) => tx.readEvents(key)))
          .map((envelope) => envelope.event)
          .findLast((event) => event.kind === "openingRecorded")
        : undefined;
      const description = opening?.kind === "openingRecorded" ? `${scene.publicDescription} ${opening.text}` : scene.publicDescription;
      const party = await this.partyFor(key, request.snapshot);
      const atmosphere = await this.atmosphereOf(key, request.snapshot);
      return { ...scenePrompt({ title: scene.title, description, party: party.descriptions, ...(atmosphere === undefined ? {} : { atmosphere }) }), caption: scene.title, references: party.references };
    }
    if (request.kind === "monsterImage") {
      const name = this.options.monsterName?.(request.monsterId, "en") ?? request.monsterId.replace(/^monster:/, "").replace(/-/g, " ");
      const shown = this.options.monsterName?.(request.monsterId, record.language) ?? name;
      const npc = request.npcId === null ? undefined : bible.npcs.find((candidate) => candidate.id === request.npcId);
      return { ...creaturePrompt({ kind: name, ...(npc === undefined ? {} : { name: npc.name, description: npc.publicDescription }) }), caption: npc?.name ?? shown };
    }
    if (request.kind === "heroImage") {
      const sheet = (await this.options.unitOfWork.transaction((tx) => tx.loadCampaign(key)))?.state.characters[request.characterId];
      if (sheet === undefined) return undefined;
      // The class by its builder name (English) when the sheet has one, so the prompt is not in the table's language.
      const className = Object.keys(sheet.classLevels ?? {})[0] ?? sheet.className ?? "adventurer";
      return { ...heroPrompt({ name: sheet.name, level: sheet.level, className, ...(sheet.race === undefined ? {} : { race: sheet.race }), gear: sheet.equipment }), caption: sheet.name };
    }
    const events = await this.options.unitOfWork.transaction((tx) => tx.readEvents(key));
    const told = events.map((envelope) => envelope.event).findLast((event) => event.kind === "narrationRecorded" && event.roundNumber === request.roundNumber);
    if (told?.kind !== "narrationRecorded") return undefined;
    const state = await this.options.unitOfWork.transaction((tx) => tx.loadCampaign(key));
    // The scene, time and party as they were when the picture was asked for; only a request without them (an old one) looks at the story now.
    const scene = findScene(bible, request.snapshot === undefined ? (state?.state.sceneId ?? null) : request.snapshot.sceneId);
    const party = await this.partyFor(key, request.snapshot);
    const atmosphere = await this.atmosphereOf(key, request.snapshot);
    return { ...momentPrompt({ narration: told.text, ...(scene === undefined ? {} : { sceneTitle: scene.title }), party: party.descriptions, ...(atmosphere === undefined ? {} : { atmosphere }) }), caption: scene?.title ?? record.name, references: party.references };
  }

  // The light of the moment: the time of day and weather the story had then (the snapshot), or has now for a request that carries none.
  private async atmosphereOf(key: CampaignKey, snapshot: PictureSnapshot | undefined): Promise<string | undefined> {
    const world = snapshot === undefined ? (await this.options.unitOfWork.transaction((tx) => tx.loadCampaign(key)))?.state.world : snapshot.world;
    return world === undefined ? undefined : `${world.time}${world.weather === undefined ? "" : `, ${world.weather}`}`;
  }

  private async partyFor(key: CampaignKey, snapshot?: PictureSnapshot): Promise<{ readonly descriptions: string[]; readonly references: { readonly name: string; readonly image: GeneratedImage }[] }> {
    const state = (await this.options.unitOfWork.transaction((tx) => tx.loadCampaign(key)))?.state;
    if (state === undefined) return { descriptions: [], references: [] };
    const descriptions: string[] = [];
    const references: { name: string; image: GeneratedImage }[] = [];
    // Who was there is what the snapshot says (with the level and gear they had then); without one, whoever is present now.
    const present = snapshot === undefined ? Object.values(state.members).flatMap((member) => (member.availability === "present" && member.characterId !== null ? [{ id: member.characterId }] : [])) : snapshot.heroes;
    for (const seen of present) {
      const hero = state.characters[seen.id];
      if (hero === undefined || (snapshot === undefined && state.heroStatus[hero.id]?.dead === true)) continue;
      const level = "level" in seen ? seen.level : hero.level;
      const equipment = "equipment" in seen ? seen.equipment : hero.equipment;
      const race = hero.race?.replace(/^race:/, "").replace(/-/g, " ") ?? "unspecified ancestry";
      const klass = Object.keys(hero.classLevels ?? {})[0] ?? hero.className ?? "adventurer";
      const image = hero.origin === undefined ? undefined : await this.options.portraits?.forGame(hero.origin.libraryCharacterId).catch(() => undefined);
      if (image !== undefined) references.push({ name: hero.name, image });
      const gear = equipment.slice(0, 3).map((item) => item.replace(/^item:/, "").replace(/-/g, " ")).join(", ");
      descriptions.push(`${hero.name}, a level ${level} ${race} ${klass}${gear === "" ? "" : ` carrying ${gear}`}${image === undefined ? "" : ` (reference image ${references.length})`}`);
    }
    return { descriptions, references };
  }

  // Records what became of a picture on the campaign record.
  private async mark(key: CampaignKey, subject: string, status: "made" | "done" | "skipped" | "failed"): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.options.unitOfWork.transaction(async (tx) => {
          const stored = await tx.loadRecord(key);
          if (stored === undefined) return;
          const record: CampaignRecord = stored.record;
          await tx.saveRecord(
            { ...record, images: { ...(record.images ?? {}), [subject]: status }, ...(status === "done" ? { lastPicture: subject } : {}) },
            stored.revision,
          );
        });
        return;
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error;
      }
    }
  }
}
