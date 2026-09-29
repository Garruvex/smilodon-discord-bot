import { buildRaces, type BuildChoices } from "../../../domain/campaign/character/character-build.js";
import type { UserId } from "../../../domain/campaign/core/ids.js";
import type { CharacterPortraitStore, GeneratedImage, ImageGenerator, PortraitStylizer } from "../ports/image-ports.js";
import type { Clock } from "../ports/clock.js";
import type { CharacterLibrary } from "./character-library.js";

// Portraits for library characters (plan §3): a player can turn a picture of
// their own into a D&D portrait, or have one painted from the character's
// description. A picture is only ever a reference for one job; the upload is
// not kept once the player has decided, and only the finished portrait stays.
// Prompts are built from the character's own build and the player's own words.

export const portraitStyles = ["painterly", "ink", "watercolor", "realistic"] as const;
export type PortraitStyle = (typeof portraitStyles)[number];
export const isPortraitStyle = (value: string): value is PortraitStyle => (portraitStyles as readonly string[]).includes(value);

export const maxUploadBytes = 8 * 1024 * 1024;
export const maxNoteLength = 200;

// What an upload really is, from its first bytes and not from what it claims
// to be; undefined for anything that is not a PNG, JPEG or WebP picture.
export function sniffImageType(bytes: Uint8Array): GeneratedImage["mediaType"] | undefined {
  const at = (index: number): number => bytes[index] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const riff = String.fromCharCode(at(0), at(1), at(2), at(3));
  const webp = String.fromCharCode(at(8), at(9), at(10), at(11));
  return riff === "RIFF" && webp === "WEBP" ? "image/webp" : undefined;
}

const styleWords: Readonly<Record<PortraitStyle, string>> = {
  painterly: "a painterly fantasy illustration, rich brushwork, dramatic lighting",
  ink: "a bold ink-and-colour comic-book illustration with strong linework",
  watercolor: "a soft storybook watercolour illustration",
  realistic: "detailed realistic tabletop-game concept art",
};

export type PortraitRefusal = "unavailable" | "notFound" | "badType" | "tooLarge" | "rateLimited" | "noSource" | "failed";
export type PortraitResult =
  | { readonly kind: "ok"; readonly image: GeneratedImage; readonly style: PortraitStyle; readonly fromUpload: boolean }
  | { readonly kind: "refused"; readonly reason: PortraitRefusal; readonly retryAfterMinutes?: number };

export interface CharacterPortraitsOptions {
  readonly library: CharacterLibrary;
  readonly store: CharacterPortraitStore;
  readonly clock: Clock;
  // Turns an upload into a portrait; absent: uploads are not offered.
  readonly stylizer?: PortraitStylizer;
  // Paints from text alone; absent: "paint from my description" is not offered.
  readonly generator?: ImageGenerator;
  // Pictures one person may ask for in an hour, so the image budget is not theirs alone.
  readonly maxPerHour?: number;
  readonly timeoutMs?: number;
}

interface Note {
  readonly style: PortraitStyle;
  readonly note: string;
  readonly fromUpload: boolean;
}

export class CharacterPortraits {
  private readonly asked = new Map<string, number[]>();

  public constructor(private readonly options: CharacterPortraitsOptions) {}

  public get canUpload(): boolean {
    return this.options.stylizer !== undefined;
  }

  public get canPaint(): boolean {
    return this.options.generator !== undefined;
  }

  public get available(): boolean {
    return this.canUpload || this.canPaint;
  }

  // The portrait in use, for the owner's screens.
  public async current(ownerUserId: UserId, characterId: string): Promise<GeneratedImage | undefined> {
    return (await this.owned(ownerUserId, characterId)) === undefined ? undefined : this.options.store.loadImage(characterId, "portrait");
  }

  // The portrait a game posts for a hero from this character (its owner put it there).
  public forGame(characterId: string): Promise<GeneratedImage | undefined> {
    return this.options.store.loadImage(characterId, "portrait");
  }

  // The made picture waiting for a yes, with what it was made from.
  public async candidate(ownerUserId: UserId, characterId: string): Promise<{ readonly image: GeneratedImage; readonly style: PortraitStyle; readonly fromUpload: boolean } | undefined> {
    if ((await this.owned(ownerUserId, characterId)) === undefined) return undefined;
    const image = await this.options.store.loadImage(characterId, "candidate");
    const note = await this.readNote(characterId);
    return image === undefined ? undefined : { image, style: note?.style ?? "painterly", fromUpload: note?.fromUpload ?? false };
  }

  // A new upload, turned into a candidate portrait.
  public async fromUpload(ownerUserId: UserId, characterId: string, bytes: Buffer, style: PortraitStyle, note: string): Promise<PortraitResult> {
    if (this.options.stylizer === undefined) return { kind: "refused", reason: "unavailable" };
    if (bytes.byteLength > maxUploadBytes) return { kind: "refused", reason: "tooLarge" };
    const mediaType = sniffImageType(bytes);
    if (mediaType === undefined) return { kind: "refused", reason: "badType" };
    const source: GeneratedImage = { bytes, mediaType };
    const character = await this.owned(ownerUserId, characterId);
    if (character === undefined) return { kind: "refused", reason: "notFound" };
    const limited = this.limit(ownerUserId);
    if (limited !== null) return limited;
    await this.options.store.saveImage(characterId, "source", source);
    return this.make(characterId, character, source, style, note.trim().slice(0, maxNoteLength), true);
  }

  // A portrait painted from the character's own description.
  public async fromDescription(ownerUserId: UserId, characterId: string, style: PortraitStyle, note: string): Promise<PortraitResult> {
    if (this.options.generator === undefined) return { kind: "refused", reason: "unavailable" };
    const character = await this.owned(ownerUserId, characterId);
    if (character === undefined) return { kind: "refused", reason: "notFound" };
    const limited = this.limit(ownerUserId);
    if (limited !== null) return limited;
    await this.options.store.removeImage(characterId, "source");
    return this.make(characterId, character, undefined, style, note.trim().slice(0, maxNoteLength), false);
  }

  // Another try at the candidate: the same upload (or description) in the given style, or the same style again.
  public async again(ownerUserId: UserId, characterId: string, style?: PortraitStyle): Promise<PortraitResult> {
    const character = await this.owned(ownerUserId, characterId);
    if (character === undefined) return { kind: "refused", reason: "notFound" };
    const before = await this.readNote(characterId);
    if (before === undefined) return { kind: "refused", reason: "noSource" };
    const source = before.fromUpload ? await this.options.store.loadImage(characterId, "source") : undefined;
    if (before.fromUpload && source === undefined) return { kind: "refused", reason: "noSource" };
    if (before.fromUpload ? this.options.stylizer === undefined : this.options.generator === undefined) return { kind: "refused", reason: "unavailable" };
    const limited = this.limit(ownerUserId);
    if (limited !== null) return limited;
    return this.make(characterId, character, source, style ?? before.style, before.note, before.fromUpload);
  }

  // The candidate becomes the portrait; the upload it came from is let go.
  public async accept(ownerUserId: UserId, characterId: string): Promise<boolean> {
    if ((await this.owned(ownerUserId, characterId)) === undefined) return false;
    const image = await this.options.store.loadImage(characterId, "candidate");
    if (image === undefined) return false;
    await this.options.store.saveImage(characterId, "portrait", image);
    await this.discard(ownerUserId, characterId);
    return true;
  }

  public async discard(ownerUserId: UserId, characterId: string): Promise<void> {
    if ((await this.owned(ownerUserId, characterId)) === undefined) return;
    await this.options.store.removeImage(characterId, "candidate");
    await this.options.store.removeImage(characterId, "source");
    await this.options.store.saveNote(characterId, "");
  }

  public async remove(ownerUserId: UserId, characterId: string): Promise<void> {
    if ((await this.owned(ownerUserId, characterId)) === undefined) return;
    await this.options.store.removeImage(characterId, "portrait");
  }

  // The character was deleted: nothing of it is kept.
  public forget(characterId: string): Promise<void> {
    return this.options.store.removeAll(characterId);
  }

  private async make(characterId: string, build: BuildChoices, source: GeneratedImage | undefined, style: PortraitStyle, note: string, fromUpload: boolean): Promise<PortraitResult> {
    const timeoutMs = this.options.timeoutMs ?? 90_000;
    try {
      const prompt = portraitPrompt(build, style, note, source !== undefined);
      const image =
        source !== undefined && this.options.stylizer !== undefined
          ? await this.options.stylizer.stylize({ source, prompt, timeoutMs })
          : await this.options.generator?.generate({ prompt, timeoutMs });
      if (image === undefined) return { kind: "refused", reason: "unavailable" };
      if (image.bytes.byteLength > maxUploadBytes) return { kind: "refused", reason: "failed" };
      await this.options.store.saveImage(characterId, "candidate", image);
      await this.options.store.saveNote(characterId, JSON.stringify({ style, note, fromUpload } satisfies Note));
      return { kind: "ok", image, style, fromUpload };
    } catch {
      return { kind: "refused", reason: "failed" };
    }
  }

  // The first saved build of a character the person owns, or undefined.
  private async owned(ownerUserId: UserId, characterId: string): Promise<BuildChoices | undefined> {
    const entry = await this.options.library.entry(ownerUserId, characterId);
    return entry?.snapshots[0]?.build;
  }

  private async readNote(characterId: string): Promise<Note | undefined> {
    const text = await this.options.store.loadNote(characterId);
    if (text === undefined || text === "") return undefined;
    try {
      const raw = JSON.parse(text) as Partial<Note>;
      return { style: typeof raw.style === "string" && isPortraitStyle(raw.style) ? raw.style : "painterly", note: typeof raw.note === "string" ? raw.note : "", fromUpload: raw.fromUpload === true };
    } catch {
      return undefined;
    }
  }

  // A sliding hour per person.
  private limit(ownerUserId: UserId): PortraitResult | null {
    const now = this.options.clock.now();
    const hour = 60 * 60 * 1000;
    const recent = (this.asked.get(ownerUserId) ?? []).filter((at) => now - at < hour);
    const max = this.options.maxPerHour ?? 6;
    if (recent.length >= max) {
      const oldest = recent[0] ?? now;
      this.asked.set(ownerUserId, recent);
      return { kind: "refused", reason: "rateLimited", retryAfterMinutes: Math.max(1, Math.ceil((oldest + hour - now) / 60_000)) };
    }
    this.asked.set(ownerUserId, [...recent, now]);
    return null;
  }
}

// The prompt for a portrait: the character's race, class and the player's own
// words about how they look, in the style chosen. With a reference picture the
// likeness is kept; without one it is painted from the words.
export function portraitPrompt(build: BuildChoices, style: PortraitStyle, note: string, hasReference: boolean): string {
  const race = build.race !== undefined && (buildRaces as readonly string[]).includes(build.race) ? build.race.replace("-", " ") : "";
  const article = race === "" ? "a" : /^[aeiou]/i.test(race) ? "an" : "a";
  const who = `${build.name}, ${article} ${race} ${build.class}`.replace(/\s+/g, " ").trim();
  const look = [build.appearance, note].map((part) => part.trim().replace(/[.s]+$/, "")).filter((part) => part.length > 0).join(". ");
  const lead = hasReference
    ? `Turn the person or figure in the reference picture into a fantasy tabletop RPG character portrait of ${who}. Keep their recognisable face, hair, expression and colouring, but dress and style them as a fantasy ${race} ${build.class} adventurer.`
    : `A fantasy tabletop RPG character portrait of ${who}.`;
  return `${lead}${look === "" ? "" : ` Details: ${look}.`} Head-and-shoulders portrait in ${styleWords[style]}. A fictional character, no text, no lettering, no watermark.`.replace(/\s+/g, " ");
}
