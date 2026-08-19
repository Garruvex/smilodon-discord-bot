import { z } from "zod";

export const booruPostSchema = z.object({
  id: z.number(),
  score: z.object({ up: z.number() }),
  fav_count: z.number(),
  rating: z.string(),
  file: z.object({ url: z.string().url().nullable(), ext: z.string(), size: z.number() }),
  tags: z.object({
    artist: z.array(z.string()).default([]),
    species: z.array(z.string()).default([]),
  }),
});
const booruResponseSchema = z.object({ posts: z.array(booruPostSchema) });

export type BooruPost = z.infer<typeof booruPostSchema>;
export type BooruSite = "e621" | "e926";

export async function fetchBooruPost(site: BooruSite, tags: string): Promise<BooruPost | null> {
  const response = await fetch(`https://${site}.net/posts.json?tags=${encodeURIComponent(tags)}&limit=1`, {
    headers: { "User-Agent": "FNTU-Discord-Bot/1.0 (+https://github.com/)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = booruResponseSchema.parse(await response.json());
  const post = data.posts[0];
  return post && post.file.url ? post : null;
}
