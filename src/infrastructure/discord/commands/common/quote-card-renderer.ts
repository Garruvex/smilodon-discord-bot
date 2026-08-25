import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { Message } from "discord.js";

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

export function getQuoteText(message: Message): string {
  const raw = message.content.trim()
    || message.embeds.find((embed) => embed.description ?? embed.title)?.description
    || message.embeds.find((embed) => embed.title)?.title
    || "";

  const withoutMarkdown = raw
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .replace(/[*_~`]/g, "")
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
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

  return withoutMarkdown.length > maxQuoteLength
    ? `${withoutMarkdown.slice(0, maxQuoteLength).trimEnd()}…`
    : withoutMarkdown;
}

// CJK scripts carry no spaces between characters, so a plain space-delimited
// word wrap never breaks them and the line runs off the canvas — each CJK
// character is tokenized individually (breakable anywhere) while Latin-ish
// runs stay glued together as words.
const cjkCharPattern = "[\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]";
const tokenPattern = new RegExp(`${cjkCharPattern}|[^\\s${cjkCharPattern.slice(1, -1)}]+|\\s+`, "gu");

function tokenize(text: string): string[] {
  return text.match(tokenPattern) ?? [];
}

function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const tokens = tokenize(text);
  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (!current) continue;
      const candidate = current + token;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = "";
      }
      continue;
    }

    const candidate = current + token;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = token;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function layoutQuote(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
): { lines: string[]; fontSize: number; lineHeight: number } {
  let fontSize = 46;
  const minFontSize = 20;

  while (fontSize >= minFontSize) {
    const lineHeight = Math.round(fontSize * 1.35);
    ctx.font = `italic ${fontSize}px "${fontFamily}"`;
    const lines = wrapText(ctx, text, maxWidth);
    if (lines.length * lineHeight <= maxHeight) {
      return { lines, fontSize, lineHeight };
    }
    fontSize -= 2;
  }

  const lineHeight = Math.round(minFontSize * 1.35);
  ctx.font = `italic ${minFontSize}px "${fontFamily}"`;
  return { lines: wrapText(ctx, text, maxWidth), fontSize: minFontSize, lineHeight };
}

async function drawCard(
  ctx: SKRSContext2D,
  message: Message,
  quoteText: string,
  botUsername: string,
): Promise<void> {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

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

  // Large decorative quotation mark behind the text, purely for visual
  // texture — drawn before the quote text so it sits behind it.
  ctx.font = `bold 260px "${fontFamily}"`;
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillText("“", textLeft - 30, 260);

  const maxTextWidth = textRight - textLeft;
  const { lines, fontSize, lineHeight } = layoutQuote(ctx, quoteText, maxTextWidth, 340);
  // A single short line reads well centered, like a pull-quote; once it
  // wraps to a paragraph, centering makes each line ragged and harder to
  // read, so it falls back to left-aligned.
  const centered = lines.length === 1;
  const textX = (line: string): number =>
    centered ? textLeft + (maxTextWidth - ctx.measureText(line).width) / 2 : textLeft;

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `italic ${fontSize}px "${fontFamily}"`;
  const blockHeight = lines.length * lineHeight;
  let y = (height - blockHeight) / 2 + fontSize * 0.8 - 20;
  for (const line of lines) {
    ctx.fillText(line, textX(line), y);
    y += lineHeight;
  }

  const authorText = `- ${message.member?.displayName ?? message.author.displayName}`;
  const handleText = `@${message.author.username}`;
  const authorY = y + 20;
  ctx.font = `italic 28px "${fontFamily}"`;
  ctx.fillStyle = "#CCCCCC";
  ctx.fillText(authorText, centered ? textX(authorText) : textLeft, authorY);

  ctx.font = `22px "${fontFamily}"`;
  ctx.fillStyle = "#777777";
  ctx.fillText(handleText, centered ? textX(handleText) : textLeft, authorY + 32);

  ctx.font = "16px \"" + fontFamily + "\"";
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  const watermark = `${botUsername}#Quote`;
  const watermarkWidth = ctx.measureText(watermark).width;
  ctx.fillText(watermark, width - 20 - watermarkWidth, height - 20);
}

export async function renderQuoteCard(message: Message, botUsername: string): Promise<Buffer> {
  const quoteText = getQuoteText(message);
  if (!quoteText) {
    throw new EmptyQuoteError();
  }

  const canvas = createCanvas(width, height);
  await drawCard(canvas.getContext("2d"), message, quoteText, botUsername);

  return canvas.toBuffer("image/png");
}
