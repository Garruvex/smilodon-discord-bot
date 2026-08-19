import { fetchBooruPost, type BooruSite } from "../../../infrastructure/booru/booru-client.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";

interface BooruSearchToolArgs {
  query: string | null;
  order: "random" | "latest" | "favorites" | "score" | null;
}

const orderTags: Record<NonNullable<BooruSearchToolArgs["order"]>, string> = {
  random: "order:random",
  latest: "order:id",
  favorites: "order:favcount",
  score: "order:score",
};

export class BooruSearchTool implements ChatTool<BooruSearchToolArgs> {
  public readonly name = "search_booru";
  public readonly description =
    "Searches e621/e926 for a furry-art image by tags (e.g. \"wolf solo\", an artist name, a species). " +
    "Automatically restricted to safe-for-work results outside age-restricted channels, regardless of what's asked.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["query", "order"],
    properties: {
      query: { type: ["string", "null"], description: "Space-separated search tags. Null for a random post." },
      order: {
        type: ["string", "null"],
        enum: ["random", "latest", "favorites", "score", null],
        description: "Sort order. Null defaults to random.",
      },
    },
  };

  public async execute(args: BooruSearchToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const site: BooruSite = ctx.channelIsNsfw ? "e621" : "e926";
    const orderTag = orderTags[args.order ?? "random"];
    const tags = [args.query, orderTag, "favcount:>100"].filter(Boolean).join(" ");
    try {
      const post = await fetchBooruPost(site, tags);
      if (!post) return { content: "No results found for that search." };
      return {
        content: JSON.stringify({
          site,
          postUrl: `https://${site}.net/posts/${post.id}`,
          mediaUrl: post.file.url,
          rating: post.rating,
          artist: post.tags.artist,
          species: post.tags.species,
        }),
      };
    } catch {
      return { content: "The image search failed. Tell the user to try again in a moment." };
    }
  }
}
