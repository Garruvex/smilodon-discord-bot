import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { StickerFormatType, type Message, type Sticker } from "discord.js";
import createEmojiMatcher from "emoji-regex";

import { fontFamily } from "../../canvas/card-font.js";

export class EmptyQuoteError extends Error {
  public constructor() {
    super("That message has no text to quote.");
    this.name = "EmptyQuoteError";
  }
}

const width = 1200;
const height = 630;
const avatarPanelWidth = 450;
const textLeft = 500;
const textRight = width - 60;
const maxQuoteLength = 300;

// Twemoji asset set, pinned so a version bump upstream can't suddenly break
// rendering. Filenames are the emoji's codepoints (variation selectors
// stripped) joined with hyphens, matching Twemoji's own naming convention.
const twemojiCdnBase = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@14.1.2/assets/72x72";

interface TextSegment {
  type: "text";
  value: string;
}

interface EmojiSegment {
  type: "emoji";
  url: string;
  fallback: string;
}

type QuoteSegment = TextSegment | EmojiSegment;

const customEmojiPattern = /<(a?):(\w+):(\d+)>/g;

function customEmojiUrl(id: string): string {
  // Discord serves a static frame for animated emoji when png is requested,
  // which is all a still image card needs.
  return `https://cdn.discordapp.com/emojis/${id}.png?size=64`;
}

function unicodeEmojiToCodepoint(emoji: string): string {
  return Array.from(emoji)
    .map((char) => char.codePointAt(0)!.toString(16))
    .filter((hex) => hex !== "fe0f")
    .join("-");
}

function unicodeEmojiUrl(emoji: string): string {
  return `${twemojiCdnBase}/${unicodeEmojiToCodepoint(emoji)}.png`;
}

function stripMarkdown(message: Message, raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .replace(/[*_~`]/g, "")
    .replace(/<@!?(\d+)>/g, (_, id: string) => {
      const mentioned = message.mentions.users.get(id);
      return mentioned ? `@${mentioned.username}` : "@user";
    })
    .replace(/<#(\d+)>/g, (_, id: string) => {
      const channel = message.mentions.channels.get(id);
      return channel && "name" in channel ? `#${channel.name}` : "#channel";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function extractRawQuoteContent(message: Message): string {
  const raw = message.content.trim()
    || message.embeds.find((embed) => embed.description ?? embed.title)?.description
    || message.embeds.find((embed) => embed.title)?.title
    || "";

  return stripMarkdown(message, raw);
}

// Splits the cleaned message text into alternating text/emoji segments,
// keeping custom-emoji tags and unicode emoji intact so the renderer can
// draw them as inline images instead of flattening them to plain text.
function tokenizeQuoteContent(text: string): QuoteSegment[] {
  const matches: { start: number; end: number; segment: EmojiSegment }[] = [];

  for (const match of text.matchAll(customEmojiPattern)) {
    const [full, , name, id] = match as unknown as [string, string, string, string];
    matches.push({
      start: match.index,
      end: match.index + full.length,
      segment: { type: "emoji", url: customEmojiUrl(id), fallback: `:${name}:` },
    });
  }

  const unicodeEmojiPattern = createEmojiMatcher();
  for (const match of text.matchAll(unicodeEmojiPattern)) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      segment: { type: "emoji", url: unicodeEmojiUrl(match[0]), fallback: match[0] },
    });
  }

  matches.sort((a, b) => a.start - b.start);

  const segments: QuoteSegment[] = [];
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

// Truncates by segment "units" (one per emoji, one per character otherwise)
// so a long run of custom emoji doesn't get cut mid-tag and a short message
// full of emoji isn't truncated far earlier than its visible length implies.
function truncateSegments(segments: QuoteSegment[], maxUnits: number): { segments: QuoteSegment[]; truncated: boolean } {
  const result: QuoteSegment[] = [];
  let used = 0;

  for (const segment of segments) {
    if (used >= maxUnits) return { segments: result, truncated: true };

    if (segment.type === "emoji") {
      result.push(segment);
      used += 1;
      continue;
    }

    const chars = Array.from(segment.value);
    if (used + chars.length <= maxUnits) {
      result.push(segment);
      used += chars.length;
    } else {
      result.push({ type: "text", value: chars.slice(0, maxUnits - used).join("") });
      used = maxUnits;
      return { segments: result, truncated: true };
    }
  }

  return { segments: result, truncated: false };
}

function segmentsToPlainText(segments: QuoteSegment[]): string {
  return segments.map((segment) => (segment.type === "text" ? segment.value : segment.fallback)).join("");
}

function getQuoteSegments(message: Message): QuoteSegment[] {
  const raw = extractRawQuoteContent(message);
  if (!raw) return [];

  const { segments, truncated } = truncateSegments(tokenizeQuoteContent(raw), maxQuoteLength);
  if (truncated) segments.push({ type: "text", value: "…" });
  return segments;
}

export function getQuoteText(message: Message): string {
  return segmentsToPlainText(getQuoteSegments(message));
}

export function hasQuotableContent(message: Message): boolean {
  return getQuoteText(message).length > 0 || message.stickers.size > 0;
}

// CJK scripts carry no spaces between characters, so a plain space-delimited
// word wrap never breaks them and the line runs off the canvas — each CJK
// character is tokenized individually (breakable anywhere) while Latin-ish
// runs stay glued together as words.
const cjkCharPattern = "[\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]";
const tokenPattern = new RegExp(`${cjkCharPattern}|[^\\s${cjkCharPattern.slice(1, -1)}]+|\\s+`, "gu");

interface TextToken {
  type: "text";
  value: string;
}

interface EmojiToken {
  type: "emoji";
  image: Image | null;
  fallback: string;
}

type LayoutToken = TextToken | EmojiToken;

function tokenizeForLayout(segments: QuoteSegment[], emojiImages: Map<string, Image | null>): LayoutToken[] {
  const tokens: LayoutToken[] = [];
  for (const segment of segments) {
    if (segment.type === "emoji") {
      tokens.push({ type: "emoji", image: emojiImages.get(segment.url) ?? null, fallback: segment.fallback });
      continue;
    }
    for (const raw of segment.value.match(tokenPattern) ?? []) {
      tokens.push({ type: "text", value: raw });
    }
  }
  return tokens;
}

async function loadEmojiImages(segments: QuoteSegment[]): Promise<Map<string, Image | null>> {
  const urls = new Set<string>();
  for (const segment of segments) {
    if (segment.type === "emoji") urls.add(segment.url);
  }

  const entries = await Promise.all(
    Array.from(urls, async (url): Promise<[string, Image | null]> => {
      try {
        const buffer = Buffer.from(await (await fetch(url)).arrayBuffer());
        return [url, await loadImage(buffer)];
      } catch {
        return [url, null];
      }
    }),
  );

  return new Map(entries);
}

function tokenWidth(ctx: SKRSContext2D, token: LayoutToken, fontSize: number): number {
  return token.type === "emoji"
    ? (token.image ? fontSize : ctx.measureText(token.fallback).width)
    : ctx.measureText(token.value).width;
}

function wrapTokens(ctx: SKRSContext2D, tokens: LayoutToken[], fontSize: number, maxWidth: number): LayoutToken[][] {
  const lines: LayoutToken[][] = [];
  let current: LayoutToken[] = [];
  let currentWidth = 0;

  for (const token of tokens) {
    if (token.type === "text" && /^\s+$/.test(token.value)) {
      if (current.length === 0) continue;
      const spaceWidth = tokenWidth(ctx, token, fontSize);
      if (currentWidth + spaceWidth <= maxWidth) {
        current.push(token);
        currentWidth += spaceWidth;
      } else {
        lines.push(current);
        current = [];
        currentWidth = 0;
      }
      continue;
    }

    const width = tokenWidth(ctx, token, fontSize);
    if (currentWidth + width <= maxWidth || current.length === 0) {
      current.push(token);
      currentWidth += width;
    } else {
      lines.push(current);
      current = [token];
      currentWidth = width;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function layoutQuote(
  ctx: SKRSContext2D,
  tokens: LayoutToken[],
  maxWidth: number,
  maxHeight: number,
): { lines: LayoutToken[][]; fontSize: number; lineHeight: number } {
  let fontSize = 46;
  const minFontSize = 20;

  while (fontSize >= minFontSize) {
    const lineHeight = Math.round(fontSize * 1.35);
    ctx.font = `italic ${fontSize}px "${fontFamily}"`;
    const lines = wrapTokens(ctx, tokens, fontSize, maxWidth);
    if (lines.length * lineHeight <= maxHeight) {
      return { lines, fontSize, lineHeight };
    }
    fontSize -= 2;
  }

  const lineHeight = Math.round(minFontSize * 1.35);
  ctx.font = `italic ${minFontSize}px "${fontFamily}"`;
  return { lines: wrapTokens(ctx, tokens, minFontSize, maxWidth), fontSize: minFontSize, lineHeight };
}

function lineWidth(ctx: SKRSContext2D, line: LayoutToken[], fontSize: number): number {
  return line.reduce((sum, token) => sum + tokenWidth(ctx, token, fontSize), 0);
}

function drawLine(ctx: SKRSContext2D, line: LayoutToken[], x: number, baselineY: number, fontSize: number): void {
  let cursorX = x;
  for (const token of line) {
    const width = tokenWidth(ctx, token, fontSize);
    if (token.type === "emoji" && token.image) {
      // Emoji sit a little above the text baseline so they optically align
      // with the surrounding glyphs instead of hanging below them.
      ctx.drawImage(token.image, cursorX, baselineY - fontSize * 0.85, fontSize, fontSize);
    } else {
      const text = token.type === "emoji" ? token.fallback : token.value;
      ctx.fillText(text, cursorX, baselineY);
    }
    cursorX += width;
  }
}

async function drawAvatarPanel(ctx: SKRSContext2D, message: Message): Promise<void> {
  const avatarUrl = message.author.displayAvatarURL({ extension: "png", size: 256 });
  try {
    const avatarBuffer = Buffer.from(await (await fetch(avatarUrl)).arrayBuffer());
    const avatarImage = await loadImage(avatarBuffer);

    const scale = Math.max(avatarPanelWidth / avatarImage.width, height / avatarImage.height);
    const drawWidth = avatarImage.width * scale;
    const drawHeight = avatarImage.height * scale;
    const drawX = (avatarPanelWidth - drawWidth) / 2;
    const drawY = (height - drawHeight) / 2;

    ctx.save();
    // A touch of blur on top of the greyscale/darken softens the avatar's
    // own edge, so it doesn't read as a flat photo cut off by the gradient.
    ctx.filter = "grayscale(100%) brightness(65%) blur(3px)";
    ctx.drawImage(avatarImage, drawX, drawY, drawWidth, drawHeight);
    ctx.restore();
  } catch {
    ctx.fillStyle = "#111111";
    ctx.fillRect(0, 0, avatarPanelWidth, height);
  }

  // Wide, multi-stop gradient (rather than one hard-edged strip) so the
  // avatar dissolves into the black panel gradually instead of along a
  // visibly straight seam.
  const blendStart = avatarPanelWidth - 300;
  const blendWidth = 400;
  const gradient = ctx.createLinearGradient(blendStart, 0, blendStart + blendWidth, 0);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.35, "rgba(0,0,0,0.12)");
  gradient.addColorStop(0.65, "rgba(0,0,0,0.55)");
  gradient.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = gradient;
  ctx.fillRect(blendStart, 0, blendWidth, height);
  ctx.fillStyle = "#000000";
  ctx.fillRect(blendStart + blendWidth, 0, width - (blendStart + blendWidth), height);
}

function drawAuthorLines(ctx: SKRSContext2D, message: Message, y: number, centered: boolean, textX: (line: string) => number): void {
  const authorText = `- ${message.member?.displayName ?? message.author.displayName}`;
  const handleText = `@${message.author.username}`;
  ctx.font = `italic 28px "${fontFamily}"`;
  ctx.fillStyle = "#CCCCCC";
  ctx.fillText(authorText, centered ? textX(authorText) : textLeft, y);

  ctx.font = `22px "${fontFamily}"`;
  ctx.fillStyle = "#777777";
  ctx.fillText(handleText, centered ? textX(handleText) : textLeft, y + 32);
}

function drawWatermark(ctx: SKRSContext2D, botUsername: string): void {
  ctx.font = "16px \"" + fontFamily + "\"";
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  const watermark = `${botUsername}#Quote`;
  const watermarkWidth = ctx.measureText(watermark).width;
  ctx.fillText(watermark, width - 20 - watermarkWidth, height - 20);
}

async function drawTextCard(
  ctx: SKRSContext2D,
  message: Message,
  segments: QuoteSegment[],
  botUsername: string,
): Promise<void> {
  await drawAvatarPanel(ctx, message);

  // Large decorative quotation mark behind the text, purely for visual
  // texture — drawn before the quote text so it sits behind it.
  ctx.font = `bold 260px "${fontFamily}"`;
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillText("“", textLeft - 30, 260);

  const emojiImages = await loadEmojiImages(segments);
  const tokens = tokenizeForLayout(segments, emojiImages);

  const maxTextWidth = textRight - textLeft;
  const { lines, fontSize, lineHeight } = layoutQuote(ctx, tokens, maxTextWidth, 340);
  // A single short line reads well centered, like a pull-quote; once it
  // wraps to a paragraph, centering makes each line ragged and harder to
  // read, so it falls back to left-aligned.
  const centered = lines.length === 1;
  const textX = (lineText: string): number =>
    centered ? textLeft + (maxTextWidth - ctx.measureText(lineText).width) / 2 : textLeft;
  const tokenLineX = (line: LayoutToken[]): number =>
    centered ? textLeft + (maxTextWidth - lineWidth(ctx, line, fontSize)) / 2 : textLeft;

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `italic ${fontSize}px "${fontFamily}"`;
  const blockHeight = lines.length * lineHeight;
  let y = (height - blockHeight) / 2 + fontSize * 0.8 - 20;
  for (const line of lines) {
    drawLine(ctx, line, tokenLineX(line), y, fontSize);
    y += lineHeight;
  }

  drawAuthorLines(ctx, message, y + 20, centered, textX);
  drawWatermark(ctx, botUsername);
}

function pickRenderableSticker(message: Message): Sticker | undefined {
  return message.stickers.find((sticker) => sticker.format !== StickerFormatType.Lottie) ?? message.stickers.first();
}

async function drawStickerCard(
  ctx: SKRSContext2D,
  message: Message,
  sticker: Sticker,
  botUsername: string,
): Promise<void> {
  await drawAvatarPanel(ctx, message);

  const maxWidth = textRight - textLeft;
  const boxSize = Math.min(maxWidth, 300);
  const boxX = textLeft + (maxWidth - boxSize) / 2;
  const boxY = (height - boxSize) / 2 - 30;

  let drewImage = false;
  if (sticker.format !== StickerFormatType.Lottie) {
    try {
      const buffer = Buffer.from(await (await fetch(sticker.url)).arrayBuffer());
      const image = await loadImage(buffer);
      const scale = Math.min(boxSize / image.width, boxSize / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      ctx.drawImage(image, boxX + (boxSize - drawWidth) / 2, boxY + (boxSize - drawHeight) / 2, drawWidth, drawHeight);
      drewImage = true;
    } catch {
      drewImage = false;
    }
  }

  if (!drewImage) {
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#FFFFFF";
    ctx.font = `italic 32px "${fontFamily}"`;
    const label = `[Sticker: ${sticker.name}]`;
    const labelWidth = ctx.measureText(label).width;
    ctx.fillText(label, textLeft + (maxWidth - labelWidth) / 2, boxY + boxSize / 2);
  }

  const textX = (lineText: string): number => textLeft + (maxWidth - ctx.measureText(lineText).width) / 2;
  drawAuthorLines(ctx, message, boxY + boxSize + 60, true, textX);
  drawWatermark(ctx, botUsername);
}

export async function renderQuoteCard(message: Message, botUsername: string): Promise<Buffer> {
  const segments = getQuoteSegments(message);
  const sticker = segments.length === 0 ? pickRenderableSticker(message) : undefined;

  if (segments.length === 0 && !sticker) {
    throw new EmptyQuoteError();
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  if (sticker) {
    await drawStickerCard(ctx, message, sticker, botUsername);
  } else {
    await drawTextCard(ctx, message, segments, botUsername);
  }

  return canvas.toBuffer("image/png");
}
