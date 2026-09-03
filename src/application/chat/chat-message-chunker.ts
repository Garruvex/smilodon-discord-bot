import type { ChatSource } from "./chat-provider.js";

// Discord's hard per-message content cap.
export const discordMessageCharLimit = 2_000;

export const chatDeliveryLimits = {
  // Default policy ceiling, independent of Discord's own per-message cap —
  // a reply this long is almost certainly not worth spreading across many
  // separate messages, so past this point the whole thing goes out as a
  // single attached .txt file instead (see planChatDelivery).
  maxChunks: 4,
  maxTotalChars: 8_000,
} as const;

export interface ChunkedChatDelivery {
  mode: "chunks";
  chunks: readonly string[];
}

export interface AttachmentChatDelivery {
  mode: "attachment";
  // Short chat message posted alongside the attachment — never the full
  // reply text itself.
  note: string;
  // The complete, untruncated response (text + rendered sources), exactly
  // as the model produced it — nothing is cut to fit here.
  attachmentText: string;
  attachmentFilename: string;
}

export type ChatDeliveryPlan = ChunkedChatDelivery | AttachmentChatDelivery;

export function buildSourceBlock(sources: readonly ChatSource[]): string {
  if (sources.length === 0) return "";
  return `\n\nSources:\n${sources.map((source) => `- [${source.title.replaceAll("[", "").replaceAll("]", "")}](${source.url})`).join("\n")}`;
}

// A bare ``` or ~~~ fence delimiter line (optionally followed by a language
// tag, e.g. "```ts") — 3+ of the same character, nothing else but the tag.
const fenceLinePattern = /^(`{3,}|~{3,})(.*)$/;

interface FenceState {
  open: boolean;
  // The exact marker + language tag text that opened the current fence, so
  // a chunk boundary inside it can be closed and reopened identically.
  openingLine: string;
  markerLength: number;
}

function toggleFence(state: FenceState, line: string): FenceState {
  const match = fenceLinePattern.exec(line.trim());
  if (!match) return state;
  const marker = match[1]!;
  if (!state.open) {
    return { open: true, openingLine: line, markerLength: marker.length };
  }
  // Closing fences don't need to match the language tag, only the marker
  // character and be at least as long — standard Markdown fence rules.
  if (marker.length >= state.markerLength) {
    return { open: false, openingLine: "", markerLength: 0 };
  }
  return state;
}

// Splits a single line too long to fit any chunk on its own into pieces
// bounded by `maxLen`, cutting only on grapheme-cluster boundaries — so a
// surrogate pair (most emoji) or a combining-mark sequence never gets torn
// in half, which would otherwise corrupt the character or trip Discord's
// own message validation.
function splitLongLine(line: string, maxLen: number): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const pieces: string[] = [];
  let current = "";
  for (const { segment } of segmenter.segment(line)) {
    if (current.length > 0 && current.length + segment.length > maxLen) {
      pieces.push(current);
      current = segment;
    } else {
      current += segment;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces.length > 0 ? pieces : [""];
}

// Packs `text` into chunks no larger than discordMessageCharLimit, splitting
// only at line/paragraph boundaries (blank lines are just empty lines here,
// so paragraph spacing survives) except for the rare line that's too long
// on its own. A fenced code block that would otherwise get cut mid-block is
// instead closed at the end of one chunk and reopened (same marker +
// language tag) at the start of the next, so every chunk stays independently
// valid Markdown.
function chunkText(text: string): string[] {
  if (text.length === 0) return [];
  const rawLines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let fence: FenceState = { open: false, openingLine: "", markerLength: 0 };

  const flush = (): void => {
    if (current.length === 0) return;
    if (fence.open) current.push("```");
    chunks.push(current.join("\n"));
    current = [];
    currentLength = 0;
  };

  for (const rawLine of rawLines) {
    const pieces = rawLine.length > discordMessageCharLimit
      ? splitLongLine(rawLine, discordMessageCharLimit)
      : [rawLine];
    for (const line of pieces) {
      const nextFence = toggleFence(fence, line);
      // Reserve room for a synthetic closing fence in case this chunk has
      // to break while `nextFence` is still open.
      const reserve = nextFence.open ? 4 : 0;
      const addedLength = (current.length > 0 ? 1 : 0) + line.length;
      if (current.length > 0 && currentLength + addedLength > discordMessageCharLimit - reserve) {
        flush();
        if (fence.open) {
          current.push(fence.openingLine);
          currentLength = fence.openingLine.length;
        }
      }
      current.push(line);
      currentLength += (current.length > 1 ? 1 : 0) + line.length;
      fence = nextFence;
    }
  }
  flush();
  return chunks;
}

/**
 * Decides how to deliver a chat reply: as a bounded sequence of Discord
 * messages (the common case), or — once it would take more messages/chars
 * than chatDeliveryLimits allows — as one short note plus the complete
 * response attached as a .txt file, so nothing about a long reply is ever
 * silently dropped the way naive truncation used to.
 */
export function planChatDelivery(text: string, sources: readonly ChatSource[]): ChatDeliveryPlan {
  const sourceBlock = buildSourceBlock(sources);
  const chunks = chunkText(text);
  if (sourceBlock) {
    const last = chunks.at(-1) ?? "";
    if (last.length + sourceBlock.length <= discordMessageCharLimit) {
      chunks[chunks.length - 1] = last + sourceBlock;
    } else {
      chunks.push(...chunkText(sourceBlock.trimStart()));
    }
  }
  const totalChars = text.length + sourceBlock.length;
  if (chunks.length > chatDeliveryLimits.maxChunks || totalChars > chatDeliveryLimits.maxTotalChars) {
    return {
      mode: "attachment",
      note: "That reply was too long to send as chat messages, so here it is as a file instead.",
      attachmentText: `${text}${sourceBlock}`,
      attachmentFilename: "response.txt",
    };
  }
  return { mode: "chunks", chunks };
}
