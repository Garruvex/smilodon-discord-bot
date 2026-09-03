import type { GeneratedChatImage } from "./chat-provider.js";
import { generatedImageLimits } from "./generated-image-limits.js";

export interface ImageDeliveryPlan {
  // Ordered groups of images, each guaranteed to fit within maxAggregateBytes
  // once per-file multipart overhead is accounted for — send one Discord
  // message per group.
  groups: readonly (readonly GeneratedChatImage[])[];
  // Images that could never be delivered at all — each one individually
  // exceeds maxAggregateBytes even alone, so no grouping could help. Report
  // these to the user rather than silently dropping them.
  undeliverable: readonly GeneratedChatImage[];
}

/**
 * Greedily packs generated images into delivery groups that each stay under
 * `maxAggregateBytes` (Discord's real per-request attachment limit varies by
 * guild boost tier — see generatedImageLimits.defaultMaxAggregateBytes), so
 * a reply carrying multiple generated images gets split across as many
 * messages as needed instead of risking one oversized request that Discord
 * rejects outright.
 */
export function planImageDelivery(
  images: readonly GeneratedChatImage[],
  maxAggregateBytes: number,
): ImageDeliveryPlan {
  const groups: GeneratedChatImage[][] = [];
  const undeliverable: GeneratedChatImage[] = [];
  let current: GeneratedChatImage[] = [];
  let currentBytes = 0;

  for (const image of images) {
    const bytes = image.data.length;
    // A lone image is checked against its raw byte size only — one file's
    // multipart framing is negligible next to any realistic byte cap, and
    // the per-image generation cap can legitimately equal the aggregate
    // delivery cap (both default to 10 MiB today), so a single max-size
    // image must still be deliverable on its own. Overhead only matters
    // once a second file is being packed alongside it.
    if (bytes > maxAggregateBytes) {
      undeliverable.push(image);
      continue;
    }
    const overhead = current.length > 0 ? generatedImageLimits.multipartOverheadBytesPerFile : 0;
    if (current.length > 0 && currentBytes + overhead + bytes > maxAggregateBytes) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(image);
    currentBytes += bytes + (current.length > 1 ? generatedImageLimits.multipartOverheadBytesPerFile : 0);
  }
  if (current.length > 0) groups.push(current);
  return { groups, undeliverable };
}
