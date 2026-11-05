import type { Embed, Message } from "discord.js";
import type { LinkPreview } from "../../../application/chat/chat-provider.js";
import { boundedLinkPreview, linkPreviewLimits } from "../../../application/chat/link-preview.js";
import type { GuardedAssetDescriptor } from "../../../application/chat/guarded-conversation-context.js";

// Discord unfurls links itself (title, site, summary, preview image) and
// serves every preview image through its own media proxy. Reading those lets
// the bot know what a shared link or GIF is about without fetching the open
// web. Only people's messages: a bot's own embeds are not conversation.

export const embedAssetPrefix = "embed-";
const maximumEmbedImages = 2;
// Unfurl images have no declared size. Their download is still bounded by
// the same byte limit as attachments; this just admits them to that check.
const embedDeclaredSize = 8 * 1024 * 1024;
const extensionTypes: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

const embedsOf = (message: Message): readonly Embed[] => message.author?.bot ? [] : message.embeds ?? [];

export function messageLinkPreviews(message: Message): LinkPreview[] {
  const previews: LinkPreview[] = [];
  for (const embed of embedsOf(message)) {
    if (previews.length >= linkPreviewLimits.perMessage) break;
    const type = String(embed.data.type);
    const preview = boundedLinkPreview({ url: embed.url, site: embed.provider?.name ?? embed.author?.name ?? null,
      title: embed.title ?? (type === "gifv" ? "GIF" : type === "image" ? "Image" : null), description: embed.description });
    if (preview) previews.push(preview);
  }
  return previews;
}

// The proxied preview image of an embed: the media itself for image and GIF
// links, the thumbnail for videos, and a large image when a page offers one.
function embedImageUrl(embed: Embed): string | null {
  const type = String(embed.data.type);
  const asset = type === "image" || type === "gifv" || type === "video" ? embed.thumbnail ?? embed.image : embed.image;
  return asset?.proxyURL ?? null;
}

function embedImageType(url: string): string | null {
  try { return extensionTypes[/\.([a-z0-9]+)$/iu.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? ""] ?? null; }
  catch { return null; }
}

export function embedImageAssets(message: Message): GuardedAssetDescriptor[] {
  const assets: GuardedAssetDescriptor[] = [];
  embedsOf(message).forEach((embed, index) => {
    const url = assets.length < maximumEmbedImages ? embedImageUrl(embed) : null;
    const contentType = url ? embedImageType(url) : null;
    if (contentType) assets.push({ id: `${embedAssetPrefix}${index}`, contentType, size: embedDeclaredSize });
  });
  return assets;
}

export function embedImageSource(message: Message, assetId: string): { url: string; contentType: string } | null {
  if (!assetId.startsWith(embedAssetPrefix) || !embedImageAssets(message).some((asset) => asset.id === assetId)) return null;
  const embed = embedsOf(message)[Number(assetId.slice(embedAssetPrefix.length))];
  const url = embed ? embedImageUrl(embed) : null;
  const contentType = url ? embedImageType(url) : null;
  return url && contentType ? { url, contentType } : null;
}
