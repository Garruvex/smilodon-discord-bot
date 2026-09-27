import { readFile } from "node:fs/promises";

import type { GeneratedImage } from "../../../application/campaign/ports/image-ports.js";

// Ready-made monster portraits bundled with the bot (assets/campaign/monster-gallery,
// see its NOTICE). Used only when a picture cannot be painted; never fetched at run time.
export function monsterGalleryImage(monsterId: string): Promise<GeneratedImage | undefined> {
  const slug = monsterId.replace(/^monster:/, "").replace(/[^a-z0-9-]/g, "").replace(/-/g, "_");
  if (slug.length === 0) return Promise.resolve(undefined);
  const url = new URL(`../../../../assets/campaign/monster-gallery/${slug}.webp`, import.meta.url);
  return readFile(url).then(
    (bytes): GeneratedImage => ({ bytes, mediaType: "image/webp" }),
    (): undefined => undefined,
  );
}
