import { createHash } from "node:crypto";

import { createCanvas, loadImage } from "@napi-rs/canvas";

import type { GeneratedImage } from "../../../application/campaign/ports/image-ports.js";
import { sniffImageType } from "../../../application/campaign/images/image-bytes.js";
import { fontFamily } from "../canvas/card-font.js";

// A hero's picture on Discord (panel spec, Hero cards): the player's portrait
// as a small square thumbnail on the public card, and the same portrait full
// size on the sheet. A hero without one gets a tile with their initials, so
// every card has the same shape and a missing portrait never blocks anything.
// Thumbnails are cut once and kept, so a card edited for HP or a condition
// re-sends the same few kilobytes and never asks a model for anything.

export interface HeroPictureFile {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface HeroPictureSubject {
  readonly characterId: string;
  readonly name: string;
  // The saved character this hero came from, when it did; its portrait is looked up by this.
  readonly libraryCharacterId?: string;
}

export interface HeroPicturesOptions {
  // A saved character's portrait; absent: every hero gets initials.
  readonly portraitFor?: (libraryCharacterId: string) => Promise<GeneratedImage | undefined>;
}

const size = 160;
const cacheLimit = 200;

// The first letter of up to two words, or the first character of a name with no spaces (a Chinese name).
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? [[...(words[0] ?? "")][0] ?? "?"] : words.slice(0, 2).map((word) => [...word][0] ?? "");
  return letters.join("").toUpperCase();
}

const extensionOf: Readonly<Record<GeneratedImage["mediaType"], string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
// A changed attachment needs a changed URL: Discord may keep the old image
// when an edited component still refers to the same attachment filename.
const fileNameOf = (characterId: string, bytes: Buffer, mediaType: GeneratedImage["mediaType"]): string => {
  const id = characterId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const version = createHash("sha1").update(bytes).digest("hex").slice(0, 12);
  return `hero-${id}-${version}.${extensionOf[mediaType]}`;
};

// A steady colour for a name, so a hero keeps the same tile.
function hueOf(name: string): number {
  const digest = createHash("sha1").update(name).digest();
  return ((digest[0] ?? 0) * 256 + (digest[1] ?? 0)) % 360;
}

export class HeroPictures {
  private readonly cache = new Map<string, HeroPictureFile>();

  public constructor(private readonly options: HeroPicturesOptions = {}) {}

  // The portrait as it is stored, for the full-size sheet; undefined when the hero has none.
  public async full(subject: HeroPictureSubject): Promise<GeneratedImage | undefined> {
    if (subject.libraryCharacterId === undefined || this.options.portraitFor === undefined) return undefined;
    return this.options.portraitFor(subject.libraryCharacterId).catch(() => undefined);
  }

  // The card's thumbnail: the portrait cut square, or an initials tile.
  public async thumbnail(subject: HeroPictureSubject): Promise<HeroPictureFile> {
    const portrait = await this.full(subject);
    const digest = portrait === undefined ? "initials" : createHash("sha1").update(portrait.bytes).digest("hex");
    const key = `${subject.characterId}|${subject.name}|${digest}`;
    const kept = this.cache.get(key);
    if (kept !== undefined) return kept;
    const cropped = portrait === undefined ? undefined : await this.cut(portrait).catch(() => undefined);
    // If the local image decoder cannot crop a valid portrait, let Discord
    // display the original instead of silently replacing it with initials.
    const original = portrait !== undefined && sniffImageType(portrait.bytes) === portrait.mediaType ? portrait : undefined;
    const bytes = cropped ?? original?.bytes ?? this.tile(subject.name);
    const mediaType = cropped === undefined && original !== undefined ? original.mediaType : "image/png";
    const file: HeroPictureFile = { name: fileNameOf(subject.characterId, bytes, mediaType), bytes };
    if (this.cache.size >= cacheLimit) this.cache.delete(this.cache.keys().next().value ?? "");
    this.cache.set(key, file);
    return file;
  }

  // The middle square of the picture, at thumbnail size.
  private async cut(portrait: GeneratedImage): Promise<Buffer> {
    const image = await loadImage(portrait.bytes);
    const side = Math.min(image.width, image.height);
    if (side <= 0) throw new Error("The portrait has no size.");
    const canvas = createCanvas(size, size);
    canvas.getContext("2d").drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
    return canvas.toBuffer("image/png");
  }

  private tile(name: string): Buffer {
    const canvas = createCanvas(size, size);
    const context = canvas.getContext("2d");
    const hue = hueOf(name);
    context.fillStyle = `hsl(${hue}, 45%, 38%)`;
    context.fillRect(0, 0, size, size);
    context.fillStyle = `hsl(${hue}, 45%, 92%)`;
    context.font = `bold 64px "${fontFamily}"`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(initialsOf(name), size / 2, size / 2 + 4);
    return canvas.toBuffer("image/png");
  }
}
