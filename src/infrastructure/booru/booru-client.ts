import { z } from "zod";

export const booruPostSchema = z.object({
  id: z.number(),
  score: z.object({ up: z.number() }),
  fav_count: z.number(),
  rating: z.enum(["s", "q", "e"]),
  file: z.object({ url: z.string().url().nullable(), ext: z.string(), size: z.number() }),
  tags: z.object({
    artist: z.array(z.string().max(200)).max(100).default([]),
    species: z.array(z.string().max(200)).max(100).default([]),
  }),
});
const booruResponseSchema = z.object({ posts: z.array(booruPostSchema) });

export type BooruPost = z.infer<typeof booruPostSchema>;
export type BooruSite = "e621" | "e926";

export async function fetchBooruPost(site: BooruSite, tags: string, signal?: AbortSignal): Promise<BooruPost | null> {
  const response = await fetch(`https://${site}.net/posts.json?tags=${encodeURIComponent(tags)}&limit=1`, {
    headers: { "User-Agent": "FNTU-Discord-Bot/1.0 (+https://github.com/)" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body || Number(response.headers.get("content-length")) > 1_048_576) throw new Error("Invalid image-search response size");
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 1_048_576) throw new Error("Image-search response exceeds budget");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = booruResponseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const post = data.posts[0];
  return post && post.file.url && (site !== "e926" || post.rating === "s") ? post : null;
}
