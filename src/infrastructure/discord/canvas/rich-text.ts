import { loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import createEmojiMatcher from "emoji-regex";

// The bundled font has no emoji glyphs, so a plain fillText draws them as empty
// boxes. Every generated image that can show a user-written name or message runs
// its text through here: emoji are cut out, fetched as pictures (Twemoji, or the
// server's own custom emoji) and drawn inline at the text's size.

// Twemoji asset set, pinned so a version bump upstream can't suddenly break
// rendering. Filenames are the emoji's codepoints (variation selectors
// stripped) joined with hyphens, matching Twemoji's own naming convention.
const twemojiCdnBase = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@14.1.2/assets/72x72";
const customEmojiPattern = /<(a?):(\w+):(\d+)>/g;
const cacheLimit = 500;

export interface TextSegment {
  readonly type: "text";
  readonly value: string;
}

export interface EmojiSegment {
  readonly type: "emoji";
  readonly url: string;
  readonly fallback: string;
}

export type RichSegment = TextSegment | EmojiSegment;

const images = new Map<string, Image>();

function customEmojiUrl(id: string): string {
  // Discord serves a static frame for animated emoji when png is requested,
  // which is all a still image needs.
  return `https://cdn.discordapp.com/emojis/${id}.png?size=64`;
}

function unicodeEmojiUrl(emoji: string): string {
  const codepoints = Array.from(emoji)
    .map((char) => char.codePointAt(0)!.toString(16))
    .filter((hex) => hex !== "fe0f")
    .join("-");
  return `${twemojiCdnBase}/${codepoints}.png`;
}

// Splits text into alternating text/emoji segments, keeping custom-emoji tags
// and unicode emoji intact.
export function splitRichText(text: string): RichSegment[] {
  const matches: { start: number; end: number; segment: EmojiSegment }[] = [];

  for (const match of text.matchAll(customEmojiPattern)) {
    const [full, , name, id] = match as unknown as [string, string, string, string];
    matches.push({
      start: match.index,
      end: match.index + full.length,
      segment: { type: "emoji", url: customEmojiUrl(id), fallback: `:${name}:` },
    });
  }
  for (const match of text.matchAll(createEmojiMatcher())) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      segment: { type: "emoji", url: unicodeEmojiUrl(match[0]), fallback: match[0] },
    });
  }
  matches.sort((a, b) => a.start - b.start);

  const segments: RichSegment[] = [];
  let cursor = 0;
  for (const { start, end, segment } of matches) {
    if (start < cursor) continue; // overlapping match (defensive)
    if (start > cursor) segments.push({ type: "text", value: text.slice(cursor, start) });
    segments.push(segment);
    cursor = end;
  }
  if (cursor < text.length) segments.push({ type: "text", value: text.slice(cursor) });
  return segments;
}

// Fetches the pictures for every emoji in these texts into the shared cache.
// A picture that cannot be fetched is left out, and its emoji is drawn as text.
export async function warmEmoji(texts: readonly (string | undefined)[]): Promise<void> {
  await warmSegments(texts.flatMap((text) => splitRichText(text ?? "")));
}

export async function warmSegments(segments: readonly RichSegment[]): Promise<void> {
  const urls = new Set<string>();
  for (const segment of segments) {
    if (segment.type === "emoji" && !images.has(segment.url)) urls.add(segment.url);
  }
  await Promise.all(
    Array.from(urls, async (url) => {
      try {
        const response = await fetch(url);
        if (!response.ok) return;
        const image = await loadImage(Buffer.from(await response.arrayBuffer()));
        if (images.size >= cacheLimit) images.delete(images.keys().next().value ?? "");
        images.set(url, image);
      } catch {
        // Drawn as its text fallback instead.
      }
    }),
  );
}

export function emojiImage(segment: EmojiSegment): Image | undefined {
  return images.get(segment.url);
}

// Width of a line of mixed text and emoji at the context's current font; each
// emoji picture is one font size wide.
export function measureRichText(ctx: SKRSContext2D, text: string, fontSize: number): number {
  return splitRichText(text).reduce((sum, segment) => {
    if (segment.type === "text") return sum + ctx.measureText(segment.value).width;
    return sum + (emojiImage(segment) !== undefined ? fontSize : ctx.measureText(segment.fallback).width);
  }, 0);
}

// Draws a line of mixed text and emoji; `align` places x at its left edge,
// centre or right edge. Needs the pictures warmed first.
export function drawRichText(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  baselineY: number,
  fontSize: number,
  align: "left" | "center" | "right" = "left",
): void {
  const total = measureRichText(ctx, text, fontSize);
  let cursor = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
  const previousAlign = ctx.textAlign;
  ctx.textAlign = "left";
  for (const segment of splitRichText(text)) {
    if (segment.type === "text") {
      ctx.fillText(segment.value, cursor, baselineY);
      cursor += ctx.measureText(segment.value).width;
      continue;
    }
    const image = emojiImage(segment);
    if (image === undefined) {
      ctx.fillText(segment.fallback, cursor, baselineY);
      cursor += ctx.measureText(segment.fallback).width;
      continue;
    }
    // Emoji sit a little above the text baseline so they optically align
    // with the surrounding glyphs instead of hanging below them.
    ctx.drawImage(image, cursor, baselineY - fontSize * 0.85, fontSize, fontSize);
    cursor += fontSize;
  }
  ctx.textAlign = previousAlign;
}
