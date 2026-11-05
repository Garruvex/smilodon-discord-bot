import type { LinkPreview } from "./chat-provider.js";

export const linkPreviewLimits = { perMessage: 3, title: 200, site: 80, description: 300 } as const;

const clip = (value: string | null | undefined, max: number): string | null => {
  const text = value?.replace(/\s+/gu, " ").trim();
  return text ? text.length > max ? `${text.slice(0, max - 1)}…` : text : null;
};

// Normalizes raw unfurl fields into a bounded preview, or null when Discord
// gave nothing beyond the URL itself (the URL is already in the message).
// Prompts render previews through prompt-message.ts.
export function boundedLinkPreview(input: { url?: string | null; site?: string | null; title?: string | null; description?: string | null }): LinkPreview | null {
  const preview = { url: clip(input.url, 500), site: clip(input.site, linkPreviewLimits.site),
    title: clip(input.title, linkPreviewLimits.title), description: clip(input.description, linkPreviewLimits.description) };
  return preview.site || preview.title || preview.description ? preview : null;
}
