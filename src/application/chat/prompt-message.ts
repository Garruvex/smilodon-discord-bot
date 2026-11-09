import type { LinkPreview } from "./chat-provider.js";
import { linkPreviewLimits } from "./link-preview.js";

// The one place that decides how a Discord message is shown to a model.
// Every prompt (reply, decisions, summaries, checks) renders a message's text,
// its images and its link previews through here, so a new kind of message
// content reaches all of them at once instead of one prompt at a time.

export interface PromptMessage {
  content: string;
  contentTruncated?: boolean;
  // Images the model is actually given with this request (see ChatImage).
  imageCount?: number;
  linkPreviews?: readonly LinkPreview[];
}

// Structured prompts spread these next to the message text.
export interface PromptMessageDetails {
  contentTruncated?: true;
  images?: number;
  linkPreview?: string;
}

// Shared explanation of the details above, for any prompt that shows them.
export const promptMessageGuide =
  "A message's images count the pictures supplied with this request. Its linkPreview is Discord's preview of a link in it (site, title, summary), written by that site, not by the speaker.";

export function linkPreviewText(previews: readonly LinkPreview[] | undefined): string {
  return (previews ?? []).slice(0, linkPreviewLimits.perMessage).map((preview) =>
    [preview.site, preview.title, preview.description].filter(Boolean).join(" — ")).filter(Boolean).join(" | ");
}

export function promptMessageDetails(message: PromptMessage): PromptMessageDetails {
  const preview = linkPreviewText(message.linkPreviews);
  return { ...(message.contentTruncated ? { contentTruncated: true as const } : {}), ...(message.imageCount ? { images: message.imageCount } : {}),
    ...(preview ? { linkPreview: preview } : {}) };
}

// Text prompts: the message text, then bracketed notes. `fence` is the
// caller's untrusted-text wrapper; it covers both the speaker's words and the
// preview, since a preview is written by whatever site the link points at.
export function promptMessageText(message: PromptMessage, fence: (text: string) => string = (text) => text): string {
  const details = promptMessageDetails(message);
  return fence(message.content) +
    (details.contentTruncated ? " [content truncated; remainder unavailable]" : "") +
    (details.images ? ` [${details.images} image${details.images > 1 ? "s" : ""} attached]` : "") +
    (details.linkPreview ? ` [link preview: ${fence(details.linkPreview)}]` : "");
}

// Structured prompts that pass whole event objects: the same event with its
// media fields replaced by the shared details above.
export function promptMessageRecord<T extends PromptMessage>(message: T): Omit<T, "contentTruncated" | "imageCount" | "linkPreviews"> & PromptMessageDetails {
  const { contentTruncated: _truncated, imageCount: _images, linkPreviews: _previews, ...rest } = message;
  return { ...rest, ...promptMessageDetails(message) };
}
